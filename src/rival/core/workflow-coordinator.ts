/**
 * Workflow Coordinator Factory
 *
 * Creates the coordinator actor that orchestrates step execution.
 * Follows Rivet's Coordinator/Data pattern.
 */

import { actor } from "rivetkit";
import type { ZodSchema } from "zod";
import type { ErrorHandler } from "../types";
import type { LoopContext, LoopPlanNode, PlanNode, StepPlanNode, StepResult } from "../types";
import { planSchema } from "../types";
import { buildStepContext } from "./context-builder";
import type {
	ExecuteContext,
	StepExecutionKickoffResult,
	StepExecutionResult,
	StepExecutionTerminalResult,
} from "./step-actor";

/**
 * Workflow coordinator state.
 */
export interface WorkflowCoordinatorState {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	workflowId: string;
	input: unknown;
	stepResults: Record<string, StepResult>;
	currentStepIndex: number;
	activeStepName: string | null;
	activeStepActorRef: string | null;
	activeStepActorKey: string | null;
	executionToken: number;
	activeLoop: ActiveLoopRuntime | null;
	startedAt: number | null;
	completedAt: number | null;
	error: string | null;
	failedStep: string | null;
}

/**
 * Result of workflow execution.
 */
export interface WorkflowExecutionResult {
	status: "running" | "completed" | "failed" | "cancelled";
	results?: Record<string, StepResult>;
	error?: string;
	failedStep?: string;
}

/**
 * Type for a step actor handle from the rivetkit client.
 */
type StepActorHandle = {
	getOrCreate: (key: string) => {
		execute: (
			ctx: ExecuteContext,
			config?: unknown,
			wfId?: string,
			stepName?: string,
			coordinatorRef?: string,
			coordinatorKey?: string,
		) => Promise<StepExecutionKickoffResult>;
		getTerminalResult: () => Promise<StepExecutionTerminalResult | null>;
		cancel?: () => Promise<void>;
	};
};

/**
 * Iteration result stored in the loop result.
 */
interface IterationResult {
	item: unknown;
	index: number;
	results: Record<string, StepResult>;
}

interface ActiveLoopRuntime {
	nodeIndex: number;
	mode: "sequential" | "parallel";
	items: unknown[];
	nextIndex: number;
	iterations: IterationResult[];
	hardFailure: boolean;
	firstHardFailureError: string | null;
	loopKeyPrefix: string;
}

interface PlanExecutionFrame {
	client: Record<string, unknown>;
	workflowId: string;
	input: unknown;
	baseStepResults: Record<string, StepResult>;
	loopContext?: LoopContext;
	loopKeyPrefix?: string;
}

interface PlanExecutionOptions {
	stepKeyForNode: (node: StepPlanNode, index: number) => string;
	unsupportedNodeBehavior: "skip" | "fail";
	onNodeStart?: (node: PlanNode, index: number) => void;
}

type PlanExecutionOutcome =
	| { ok: true; stepResults: Record<string, StepResult> }
	| { ok: false; error: string; failedNode: string; stepResults: Record<string, StepResult> };

/**
 * Creates a workflow coordinator actor.
 *
 * @param workflowName - Name of the workflow
 * @param plan - The execution plan (array of PlanNodes)
 * @param inputSchema - Optional Zod schema for input validation
 */
export function createWorkflowCoordinator(
	workflowName: string,
	plan: PlanNode[],
	inputSchema?: ZodSchema,
	workflowOnError?: ErrorHandler,
) {
	function nextExecutionToken(current: number | undefined): number {
		return Number.isFinite(current) ? (current as number) + 1 : 1;
	}

	// Validate plan structure and unique step names
	const result = planSchema.safeParse(plan);
	if (!result.success) {
		const messages = result.error.issues.map((i) => i.message).join("; ");
		throw new Error(`Workflow "${workflowName}" has an invalid plan: ${messages}`);
	}

	/**
	 * Get a step actor handle from the client, or return an error string.
	 */
	function getStepActorHandle(
		client: Record<string, unknown>,
		actorRef: string,
	): StepActorHandle | undefined {
		return (client as Record<string, unknown>)[actorRef] as StepActorHandle | undefined;
	}

	/**
	 * Execute a single step node.
	 * Returns { ok: true, result } on success/continue, or { ok: false, ... } on hard failure.
	 */
	async function executeStepNode(
		node: StepPlanNode,
		client: Record<string, unknown>,
		workflowId: string,
		input: unknown,
		stepResults: Record<string, StepResult>,
		stepKey: string,
		loopContext?: LoopContext,
	): Promise<
		| { ok: true; result: StepExecutionResult; status: "completed" | "failed" | "skipped" }
		| { ok: false; error: string }
	> {
		const handle = getStepActorHandle(client, node.actorRef);
		if (!handle) {
			return { ok: false, error: `Actor ref "${node.actorRef}" not found in registry` };
		}

		const stepActor = handle.getOrCreate(stepKey);

		const context = buildStepContext({
			input,
			stepResults,
			loopContext,
		});

		await stepActor.execute(context, node.config, workflowId, node.name);

		const execResult = await waitForStepTerminal(stepActor);

		if (execResult.status === "failed" && !execResult.continueOnError) {
			return { ok: false, error: execResult.error ?? "Step failed" };
		}

		return { ok: true, result: execResult, status: execResult.status };
	}

	function toStepResult(
		stepResult: StepExecutionResult,
		status: "completed" | "failed" | "skipped",
	): StepResult {
		return {
			result: stepResult.result,
			state: stepResult.stepState,
			status,
		};
	}

	async function waitForStepTerminal(
		stepActor: ReturnType<StepActorHandle["getOrCreate"]>,
	): Promise<StepExecutionTerminalResult> {
		for (;;) {
			const terminal = await stepActor.getTerminalResult();
			if (terminal) return terminal;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	async function invokeWorkflowOnError(
		c: {
			state: WorkflowCoordinatorState;
		},
		errorMessage: string,
		failedStep: string,
	) {
		if (!workflowOnError) return;
		try {
			await workflowOnError({
				error: new Error(errorMessage),
				failedStep: {
					result: c.state.stepResults[failedStep]?.result,
					state: c.state.stepResults[failedStep]?.state ?? {},
					stepName: failedStep,
					status: c.state.stepResults[failedStep]?.status ?? "failed",
				},
				workflowState: {
					input: c.state.input,
					steps: c.state.stepResults,
					status: c.state.status,
					runId: c.state.workflowId,
					workflowName,
				},
			});
		} catch {
			console.error(`[${workflowName}/${c.state.workflowId}] Workflow onError handler failed`);
		}
	}

	/**
	 * Execute a list of plan nodes in order.
	 */
	async function executePlanNodes(
		nodes: PlanNode[],
		frame: PlanExecutionFrame,
		options: PlanExecutionOptions,
	): Promise<PlanExecutionOutcome> {
		const planStepResults: Record<string, StepResult> = {};

		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if (!node) continue;

			options.onNodeStart?.(node, i);

			const mergedStepResults = { ...frame.baseStepResults, ...planStepResults };

			if (node.type === "step") {
				const stepKey = options.stepKeyForNode(node, i);
				const stepResult = await executeStepNode(
					node,
					frame.client,
					frame.workflowId,
					frame.input,
					mergedStepResults,
					stepKey,
					frame.loopContext,
				);

				if (!stepResult.ok) {
					planStepResults[node.name] = {
						result: undefined,
						state: {},
						status: "failed",
					};
					return {
						ok: false,
						error: stepResult.error,
						failedNode: node.name,
						stepResults: planStepResults,
					};
				}

				planStepResults[node.name] = toStepResult(stepResult.result, stepResult.status);
				continue;
			}

			if (node.type === "loop") {
				const loopResult = await executeLoopNode(
					node,
					frame.client,
					frame.workflowId,
					frame.input,
					mergedStepResults,
					frame.loopContext,
					frame.loopKeyPrefix,
				);

				if (!loopResult.ok) {
					planStepResults[node.name] = loopResult.loopResult ?? {
						result: undefined,
						state: {},
						status: "failed",
					};
					return {
						ok: false,
						error: loopResult.error,
						failedNode: node.name,
						stepResults: planStepResults,
					};
				}

				planStepResults[node.name] = loopResult.loopResult;
				continue;
			}

			if (options.unsupportedNodeBehavior === "skip") {
				continue;
			}

			planStepResults[node.name] = {
				result: undefined,
				state: {},
				status: "failed",
			};
			return {
				ok: false,
				error: `Unsupported node type "${node.type}"`,
				failedNode: node.name,
				stepResults: planStepResults,
			};
		}

		return { ok: true, stepResults: planStepResults };
	}

	/**
	 * Execute a loop node (forEach).
	 */
	async function executeLoopNode(
		node: LoopPlanNode,
		client: Record<string, unknown>,
		workflowId: string,
		input: unknown,
		parentStepResults: Record<string, StepResult>,
		parentLoopContext?: LoopContext,
		parentLoopKeyPrefix?: string,
	): Promise<
		{ ok: true; loopResult: StepResult } | { ok: false; error: string; loopResult?: StepResult }
	> {
		const loopName = node.name;
		const mode = node.parallel ? "parallel" : "sequential";
		const loopKeyPrefix = `${parentLoopKeyPrefix || ""}${loopName}-`;

		// 1. Execute iterator actor to get items
		const iteratorHandle = getStepActorHandle(client, node.iteratorActorRef);
		if (!iteratorHandle) {
			return {
				ok: false,
				error: `Iterator actor ref "${node.iteratorActorRef}" not found in registry`,
			};
		}

		const iteratorKey = `${workflowId}-${loopKeyPrefix}iterator`;
		const iteratorActor = iteratorHandle.getOrCreate(iteratorKey);
		const iteratorContext = buildStepContext({
			input,
			stepResults: parentStepResults,
			loopContext: parentLoopContext,
		});
		await iteratorActor.execute(iteratorContext, undefined, workflowId, `${loopName}:iterator`);
		const iteratorResult = await waitForStepTerminal(iteratorActor);

		if (iteratorResult.status === "failed") {
			return { ok: false, error: iteratorResult.error ?? "Iterator failed" };
		}

		const items = iteratorResult.result;
		if (!Array.isArray(items)) {
			return {
				ok: false,
				error: `forEach "${loopName}": iterator must return an array, got ${typeof items}`,
			};
		}

		console.log(
			`[${workflowName}/${workflowId}] Loop "${loopName}": ${items.length} items (${mode})`,
		);

		// 2. Execute do-nodes for each item
		const doNodes = node.do;

		if (items.length === 0) {
			// Empty loop — complete immediately
			const loopResult: StepResult = {
				result: { iterations: [] },
				state: {},
				status: "completed",
			};
			return { ok: true, loopResult };
		}

		const frozenItems = Object.freeze([...items]);

		if (node.parallel) {
			return executeLoopParallel(
				loopName,
				doNodes,
				frozenItems,
				client,
				workflowId,
				input,
				parentStepResults,
				loopKeyPrefix,
			);
		}

		return executeLoopSequential(
			loopName,
			doNodes,
			frozenItems,
			client,
			workflowId,
			input,
			parentStepResults,
			loopKeyPrefix,
		);
	}

	/**
	 * Execute loop iterations sequentially.
	 */
	async function executeLoopSequential(
		loopName: string,
		doNodes: PlanNode[],
		items: readonly unknown[],
		client: Record<string, unknown>,
		workflowId: string,
		input: unknown,
		parentStepResults: Record<string, StepResult>,
		loopKeyPrefix: string,
	): Promise<
		{ ok: true; loopResult: StepResult } | { ok: false; error: string; loopResult?: StepResult }
	> {
		const iterations: IterationResult[] = [];

		// Nested loop bodies still execute synchronously within a single action.
		// Top-level loops are continuation-driven via `_continueLoop`.
		for (let idx = 0; idx < items.length; idx++) {
			const item = items[idx];
			const iterationStepResults: Record<string, StepResult> = {};

			const loopContext: LoopContext = { item, index: idx, items };

			console.log(
				`[${workflowName}/${workflowId}] Loop "${loopName}": iteration ${idx + 1}/${items.length}`,
			);

			const iterationResult = await executePlanNodes(
				doNodes,
				{
					client,
					workflowId,
					input,
					baseStepResults: parentStepResults,
					loopContext,
					loopKeyPrefix: `${loopKeyPrefix}iter${idx}-`,
				},
				{
					stepKeyForNode: (stepNode) => `${workflowId}-${loopKeyPrefix}iter${idx}-${stepNode.name}`,
					unsupportedNodeBehavior: "fail",
				},
			);
			Object.assign(iterationStepResults, iterationResult.stepResults);

			if (!iterationResult.ok) {
				iterations.push({ item, index: idx, results: iterationStepResults });
				const loopResult: StepResult = {
					result: { iterations },
					state: {},
					status: "failed",
				};
				return {
					ok: false,
					error: iterationResult.error,
					loopResult,
				};
			}

			iterations.push({ item, index: idx, results: iterationStepResults });
		}

		const loopResult: StepResult = {
			result: { iterations },
			state: {},
			status: "completed",
		};
		return { ok: true, loopResult };
	}

	/**
	 * Execute loop iterations in parallel.
	 */
	async function executeLoopParallel(
		loopName: string,
		doNodes: PlanNode[],
		items: readonly unknown[],
		client: Record<string, unknown>,
		workflowId: string,
		input: unknown,
		parentStepResults: Record<string, StepResult>,
		loopKeyPrefix: string,
	): Promise<
		{ ok: true; loopResult: StepResult } | { ok: false; error: string; loopResult?: StepResult }
	> {
		const iterationPromises = items.map(async (item, idx) => {
			// Shallow copy parent results to prevent cross-iteration mutation
			const parentSnapshot = { ...parentStepResults };
			const loopContext: LoopContext = { item, index: idx, items };

			const iterationResult = await executePlanNodes(
				doNodes,
				{
					client,
					workflowId,
					input,
					baseStepResults: parentSnapshot,
					loopContext,
					loopKeyPrefix: `${loopKeyPrefix}iter${idx}-`,
				},
				{
					stepKeyForNode: (stepNode) => `${workflowId}-${loopKeyPrefix}iter${idx}-${stepNode.name}`,
					unsupportedNodeBehavior: "fail",
				},
			);

			return {
				item,
				index: idx,
				results: iterationResult.stepResults,
				hardFailure: !iterationResult.ok,
				hardFailureError: iterationResult.ok ? undefined : iterationResult.error,
			};
		});

		const settled = await Promise.allSettled(iterationPromises);
		const iterations: IterationResult[] = [];
		let anyHardFailure = false;
		let firstHardFailureError: string | undefined;

		for (const s of settled) {
			if (s.status === "fulfilled") {
				iterations.push({
					item: s.value.item,
					index: s.value.index,
					results: s.value.results,
				});
				if (s.value.hardFailure) {
					anyHardFailure = true;
					firstHardFailureError ??= s.value.hardFailureError;
				}
			} else {
				anyHardFailure = true;
				firstHardFailureError ??= s.reason instanceof Error ? s.reason.message : String(s.reason);
			}
		}

		// Sort by index to maintain deterministic order
		iterations.sort((a, b) => a.index - b.index);

		console.log(
			`[${workflowName}/${workflowId}] Loop "${loopName}": all ${items.length} parallel iterations complete`,
		);

		const loopResult: StepResult = {
			result: { iterations },
			state: {},
			status: anyHardFailure ? "failed" : "completed",
		};
		if (anyHardFailure) {
			return {
				ok: false,
				error: firstHardFailureError ?? `Loop "${loopName}" had a failed iteration`,
				loopResult,
			};
		}

		return { ok: true, loopResult };
	}

	return actor({
		state: {
			status: "pending" as WorkflowCoordinatorState["status"],
			workflowId: "",
			input: {} as unknown,
			stepResults: {} as Record<string, StepResult>,
			currentStepIndex: 0,
			activeStepName: null as string | null,
			activeStepActorRef: null as string | null,
			activeStepActorKey: null as string | null,
			executionToken: 0,
			activeLoop: null as ActiveLoopRuntime | null,
			startedAt: null as number | null,
			completedAt: null as number | null,
			error: null as string | null,
			failedStep: null as string | null,
		},

		actions: {
			/**
			 * Run the workflow with the given input.
			 */
			run: async (
				c,
				workflowId: string,
				rawInput: unknown = {},
			): Promise<WorkflowExecutionResult> => {
				// Prevent double-run
				if (c.state.status === "running") {
					throw new Error("Workflow already running");
				}

				// Validate input if schema provided
				let input: unknown = rawInput;
				if (inputSchema) {
					const parseResult = inputSchema.safeParse(rawInput);
					if (!parseResult.success) {
						c.state.status = "failed";
						c.state.error = `Input validation failed: ${parseResult.error.message}`;
						c.state.failedStep = "__input__";
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, "__input__");
						return { status: "failed", error: c.state.error };
					}
					input = parseResult.data;
				}

				// Initialize state
				c.state.status = "running";
				c.state.workflowId = workflowId;
				c.state.input = input;
				c.state.startedAt = Date.now();
				c.state.completedAt = null;
				c.state.stepResults = {};
				c.state.currentStepIndex = 0;
				c.state.activeStepName = null;
				c.state.activeStepActorRef = null;
				c.state.activeStepActorKey = null;
				c.state.activeLoop = null;
				c.state.error = null;
				c.state.failedStep = null;
				c.state.executionToken = nextExecutionToken(c.state.executionToken);

				// Log plan summary
				const nodeNames = plan.map((n) => {
					if (n.type === "step") return n.name;
					if (n.type === "loop") return `forEach(${n.name})`;
					return n.name;
				});

				console.log(`[${workflowName}/${workflowId}] Starting workflow`);
				console.log(`[${workflowName}/${workflowId}] Plan: ${nodeNames.join(" → ")}`);
				await c.schedule.after(0, "_continue", c.state.executionToken);
				return { status: "running" };
			},

			_continue: async (c, token: number): Promise<void> => {
				if (c.state.executionToken !== token || c.state.status !== "running") {
					return;
				}

				if (c.state.currentStepIndex >= plan.length) {
					c.state.status = "completed";
					c.state.completedAt = Date.now();
					c.state.activeStepName = null;
					c.state.activeStepActorRef = null;
					c.state.activeStepActorKey = null;
					c.state.activeLoop = null;
					console.log(`[${workflowName}/${c.state.workflowId}] Workflow completed!`);
					return;
				}

				const node = plan[c.state.currentStepIndex];
				if (!node) {
					c.state.currentStepIndex += 1;
					await c.schedule.after(0, "_continue", token);
					return;
				}

				if (node.type === "step") {
					const client = c.client() as Record<string, unknown>;
					const handle = getStepActorHandle(client, node.actorRef);
					if (!handle) {
						c.state.stepResults[node.name] = {
							result: undefined,
							state: {},
							status: "failed",
						};
						c.state.status = "failed";
						c.state.error = `Actor ref "${node.actorRef}" not found in registry`;
						c.state.failedStep = node.name;
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, node.name);
						return;
					}

					const stepKey = `${c.state.workflowId}-${node.name}`;
					const stepActor = handle.getOrCreate(stepKey);
					const context = buildStepContext({
						input: c.state.input,
						stepResults: c.state.stepResults,
					});

					c.state.activeStepName = node.name;
					c.state.activeStepActorRef = node.actorRef;
					c.state.activeStepActorKey = stepKey;
					await stepActor.execute(
						context,
						node.config,
						c.state.workflowId,
						node.name,
						c.name,
						c.state.workflowId,
					);
					return;
				}

				if (node.type === "loop") {
					const client = c.client() as Record<string, unknown>;
					const iteratorHandle = getStepActorHandle(client, node.iteratorActorRef);
					if (!iteratorHandle) {
						c.state.stepResults[node.name] = {
							result: undefined,
							state: {},
							status: "failed",
						};
						c.state.status = "failed";
						c.state.error = `Iterator actor ref "${node.iteratorActorRef}" not found in registry`;
						c.state.failedStep = node.name;
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, node.name);
						return;
					}

					const loopKeyPrefix = `${node.name}-`;
					const iteratorKey = `${c.state.workflowId}-${loopKeyPrefix}iterator`;
					const iteratorActor = iteratorHandle.getOrCreate(iteratorKey);
					const iteratorContext = buildStepContext({
						input: c.state.input,
						stepResults: c.state.stepResults,
					});
					await iteratorActor.execute(
						iteratorContext,
						undefined,
						c.state.workflowId,
						`${node.name}:iterator`,
					);
					const iteratorResult = await waitForStepTerminal(iteratorActor);

					if (iteratorResult.status === "failed") {
						c.state.stepResults[node.name] = {
							result: undefined,
							state: {},
							status: "failed",
						};
						c.state.status = "failed";
						c.state.error = iteratorResult.error ?? "Iterator failed";
						c.state.failedStep = node.name;
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, node.name);
						return;
					}

					const items = iteratorResult.result;
					if (!Array.isArray(items)) {
						c.state.stepResults[node.name] = {
							result: undefined,
							state: {},
							status: "failed",
						};
						c.state.status = "failed";
						c.state.error = `forEach "${node.name}": iterator must return an array, got ${typeof items}`;
						c.state.failedStep = node.name;
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, node.name);
						return;
					}

					c.state.activeLoop = {
						nodeIndex: c.state.currentStepIndex,
						mode: node.parallel ? "parallel" : "sequential",
						items,
						nextIndex: 0,
						iterations: [],
						hardFailure: false,
						firstHardFailureError: null,
						loopKeyPrefix,
					};
					await c.schedule.after(0, "_continueLoop", token);
					return;
				}

				c.state.currentStepIndex += 1;
				await c.schedule.after(0, "_continue", token);
			},

			_continueLoop: async (c, token: number): Promise<void> => {
				if (c.state.executionToken !== token || c.state.status !== "running") return;

				const runtime = c.state.activeLoop;
				if (!runtime) {
					await c.schedule.after(0, "_continue", token);
					return;
				}

				const node = plan[runtime.nodeIndex];
				if (!node || node.type !== "loop") {
					c.state.activeLoop = null;
					await c.schedule.after(0, "_continue", token);
					return;
				}

				if (runtime.items.length === 0) {
					c.state.stepResults[node.name] = {
						result: { iterations: [] },
						state: {},
						status: "completed",
					};
					c.state.activeLoop = null;
					c.state.currentStepIndex += 1;
					await c.schedule.after(0, "_continue", token);
					return;
				}

				if (runtime.nextIndex >= runtime.items.length) {
					const status: "completed" | "failed" = runtime.hardFailure ? "failed" : "completed";
					c.state.stepResults[node.name] = {
						result: { iterations: runtime.iterations },
						state: {},
						status,
					};

					c.state.activeLoop = null;

					if (status === "failed") {
						c.state.status = "failed";
						c.state.error =
							runtime.firstHardFailureError ?? `Loop "${node.name}" had a failed iteration`;
						c.state.failedStep = node.name;
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, node.name);
						return;
					}

					c.state.currentStepIndex += 1;
					await c.schedule.after(0, "_continue", token);
					return;
				}

				const idx = runtime.nextIndex;
				const item = runtime.items[idx];
				const loopContext: LoopContext = { item, index: idx, items: runtime.items };
				const iterationResult = await executePlanNodes(
					node.do,
					{
						client: c.client() as Record<string, unknown>,
						workflowId: c.state.workflowId,
						input: c.state.input,
						baseStepResults: c.state.stepResults,
						loopContext,
						loopKeyPrefix: `${runtime.loopKeyPrefix}iter${idx}-`,
					},
					{
						stepKeyForNode: (stepNode) =>
							`${c.state.workflowId}-${runtime.loopKeyPrefix}iter${idx}-${stepNode.name}`,
						unsupportedNodeBehavior: "fail",
					},
				);

				runtime.iterations.push({
					item,
					index: idx,
					results: iterationResult.stepResults,
				});
				runtime.nextIndex += 1;

				if (!iterationResult.ok) {
					runtime.hardFailure = true;
					runtime.firstHardFailureError ??= iterationResult.error;
					if (runtime.mode === "sequential") {
						runtime.nextIndex = runtime.items.length;
					}
				}

				c.state.activeLoop = runtime;
				await c.schedule.after(0, "_continueLoop", token);
			},

			onStepFinished: async (
				c,
				stepName: string,
				status: "completed" | "failed" | "skipped" | "cancelled",
				result: unknown,
				error: string | null | undefined,
				stepState: Record<string, unknown>,
				continueOnError?: boolean,
			): Promise<void> => {
				if (c.state.status !== "running") return;
				// `activeStepName` acts as the current-run nonce for callbacks:
				// stale callbacks (from cancelled/replaced runs) are ignored.
				if (c.state.activeStepName === null || c.state.activeStepName !== stepName) return;
				// NOTE: step actor `cancel()` does not emit callbacks today, so `cancelled`
				// is currently defensive typing for forward compatibility.

				c.state.stepResults[stepName] = {
					result,
					state: stepState,
					status,
				};

				const stepHardFailed = status === "failed" && !continueOnError;
				c.state.activeStepName = null;
				c.state.activeStepActorRef = null;
				c.state.activeStepActorKey = null;

				if (stepHardFailed) {
					c.state.status = "failed";
					c.state.error = error ?? "Step failed";
					c.state.failedStep = stepName;
					c.state.completedAt = Date.now();
					await invokeWorkflowOnError(c, c.state.error, stepName);
					return;
				}

				c.state.currentStepIndex += 1;
				await c.schedule.after(0, "_continue", c.state.executionToken);
			},

			/**
			 * Get the current state of the workflow.
			 */
			getState: (c): WorkflowCoordinatorState & { duration: number | null } => ({
				status: c.state.status,
				workflowId: c.state.workflowId,
				input: c.state.input,
				stepResults: c.state.stepResults,
				currentStepIndex: c.state.currentStepIndex,
				activeStepName: c.state.activeStepName,
				activeStepActorRef: c.state.activeStepActorRef,
				activeStepActorKey: c.state.activeStepActorKey,
				executionToken: c.state.executionToken,
				activeLoop: c.state.activeLoop,
				startedAt: c.state.startedAt,
				completedAt: c.state.completedAt,
				error: c.state.error,
				failedStep: c.state.failedStep,
				duration:
					c.state.completedAt && c.state.startedAt ? c.state.completedAt - c.state.startedAt : null,
			}),

			/**
			 * Cancel the workflow.
			 */
			cancel: async (c) => {
				if (c.state.status !== "running") {
					return;
				}

				c.state.status = "cancelled";
				c.state.completedAt = Date.now();
				c.state.executionToken = nextExecutionToken(c.state.executionToken);

				const activeRef = c.state.activeStepActorRef;
				const activeKey = c.state.activeStepActorKey;
				c.state.activeStepName = null;
				c.state.activeStepActorRef = null;
				c.state.activeStepActorKey = null;
				c.state.activeLoop = null;

				if (activeRef && activeKey) {
					try {
						const client = c.client() as Record<string, unknown>;
						const handle = getStepActorHandle(client, activeRef);
						await handle?.getOrCreate(activeKey).cancel?.();
					} catch {
						// Best effort only.
					}
				}

				// Note: Cannot truly cancel in-flight step execution,
				// but we mark workflow as cancelled to prevent further steps.
				console.log(`[${workflowName}/${c.state.workflowId}] Workflow cancelled`);
			},
		},
	});
}
