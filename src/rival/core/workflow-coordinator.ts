/**
 * Workflow Coordinator Factory
 *
 * Creates the coordinator actor that orchestrates step execution.
 * Follows Rivet's Coordinator/Data pattern.
 */

import { actor } from "rivetkit";
import type { ZodSchema } from "zod";
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
	startedAt: number | null;
	completedAt: number | null;
	error: string | null;
	failedStep: string | null;
}

/**
 * Result of workflow execution.
 */
export interface WorkflowExecutionResult {
	status: "completed" | "failed" | "cancelled";
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

interface PlanExecutionFrame {
	client: Record<string, unknown>;
	workflowId: string;
	input: unknown;
	baseStepResults: Record<string, StepResult>;
	loopContext?: LoopContext;
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
) {
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

		await stepActor.execute(
			context,
			node.config,
			workflowId,
			node.name,
			`${workflowName}_coordinator`,
			workflowId,
		);

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
			await sleep(25);
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
	): Promise<
		{ ok: true; loopResult: StepResult } | { ok: false; error: string; loopResult?: StepResult }
	> {
		const loopName = node.name;
		const mode = node.parallel ? "parallel" : "sequential";

		// 1. Execute iterator actor to get items
		const iteratorHandle = getStepActorHandle(client, node.iteratorActorRef);
		if (!iteratorHandle) {
			return {
				ok: false,
				error: `Iterator actor ref "${node.iteratorActorRef}" not found in registry`,
			};
		}

		const iteratorKey = `${workflowId}-${loopName}-iterator`;
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
	): Promise<
		{ ok: true; loopResult: StepResult } | { ok: false; error: string; loopResult?: StepResult }
	> {
		const iterations: IterationResult[] = [];

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
				},
				{
					stepKeyForNode: (stepNode) => `${workflowId}-${loopName}-iter${idx}-${stepNode.name}`,
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
				},
				{
					stepKeyForNode: (stepNode) => `${workflowId}-${loopName}-iter${idx}-${stepNode.name}`,
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
						return { status: "failed", error: c.state.error };
					}
					input = parseResult.data;
				}

				// Initialize state
				c.state.status = "running";
				c.state.workflowId = workflowId;
				c.state.input = input;
				c.state.startedAt = Date.now();
				c.state.stepResults = {};
				c.state.currentStepIndex = 0;

				// Log plan summary
				const nodeNames = plan.map((n) => {
					if (n.type === "step") return n.name;
					if (n.type === "loop") return `forEach(${n.name})`;
					return n.name;
				});

				console.log(`[${workflowName}/${workflowId}] Starting workflow`);
				console.log(`[${workflowName}/${workflowId}] Plan: ${nodeNames.join(" → ")}`);

				const client = c.client() as Record<string, unknown>;
				const executionResult = await executePlanNodes(
					plan,
					{
						client,
						workflowId,
						input: c.state.input,
						baseStepResults: c.state.stepResults,
					},
					{
						stepKeyForNode: (stepNode) => `${workflowId}-${stepNode.name}`,
						unsupportedNodeBehavior: "skip",
						onNodeStart: (_, i) => {
							c.state.currentStepIndex = i;
						},
					},
				);

				Object.assign(c.state.stepResults, executionResult.stepResults);
				if (!executionResult.ok) {
					c.state.status = "failed";
					c.state.error = executionResult.error;
					c.state.failedStep = executionResult.failedNode;
					c.state.completedAt = Date.now();

					console.log(
						`[${workflowName}/${workflowId}] Failed at node: ${executionResult.failedNode}`,
					);
					return {
						status: "failed",
						error: executionResult.error,
						failedStep: executionResult.failedNode,
						results: c.state.stepResults,
					};
				}

				// All steps completed
				c.state.status = "completed";
				c.state.completedAt = Date.now();

				console.log(`[${workflowName}/${workflowId}] Workflow completed!`);
				return { status: "completed", results: c.state.stepResults };
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

				// Note: Cannot truly cancel in-flight step execution,
				// but we mark workflow as cancelled to prevent further steps.
				console.log(`[${workflowName}/${c.state.workflowId}] Workflow cancelled`);
			},
		},
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
