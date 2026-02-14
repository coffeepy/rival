/**
 * Workflow Coordinator Factory
 *
 * Creates the coordinator actor that orchestrates step execution.
 * Follows Rivet's Coordinator/Data pattern.
 */

import { actor } from "rivetkit";
import type { ZodSchema } from "zod";
import type { ErrorHandler } from "../types";
import type { LoopContext, PlanNode, StepResult } from "../types";
import { planSchema } from "../types";
import {
	getCoordinatorCallbackHandle,
	getLoopActorHandle,
	getParallelActorHandle,
	getRivalClient,
	getStepActorHandle,
} from "./actor-handles";
import { buildStepContext } from "./context-builder";
import {
	propagateLoopCancel,
	propagateParallelCancel,
	propagateStepCancel,
} from "./orchestration/cancel";
import { isHardChildStatus, isHardStepStatus, terminalError } from "./orchestration/policy";
import { nextExecutionToken } from "./orchestration/tokens";

/**
 * Workflow coordinator state.
 */
export interface WorkflowCoordinatorState {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	workflowId: string;
	input: unknown;
	stepResults: Record<string, StepResult>;
	nodes: Array<{ id: string; alias: string; type: "step" | "loop" | "parallel" | "other" }>;
	currentStepIndex: number;
	activeStepAlias: string | null;
	activeStepActorRef: string | null;
	activeStepActorKey: string | null;
	activeLoopCoordinatorRef: string | null;
	activeLoopCoordinatorKey: string | null;
	pendingLoopCallbackName: string | null;
	activeParallelAlias: string | null;
	activeParallelRef: string | null;
	activeParallelKey: string | null;
	pendingParallelCallbackName: string | null;
	parentRef: string | null;
	parentKey: string | null;
	parentCallbackName: string | null;
	parentToken: number;
	parentLoopContext: LoopContext | null;
	executionToken: number;
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

export const WORKFLOW_TERMINAL_EVENT = "__rival_workflow_terminal__";

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
	const result = planSchema.safeParse(plan);
	if (!result.success) {
		const messages = result.error.issues.map((i) => i.message).join("; ");
		throw new Error(`Workflow "${workflowName}" has an invalid plan: ${messages}`);
	}

	async function notifyParent(c: {
		state: WorkflowCoordinatorState;
		client: () => unknown;
	}) {
		const parentRef = c.state.parentRef;
		const parentKey = c.state.parentKey;
		const parentCallbackName = c.state.parentCallbackName;
		if (!parentRef || !parentKey || !parentCallbackName) return;

		const rivalClient = getRivalClient(c.client());
		const handle = getCoordinatorCallbackHandle(rivalClient, parentRef);
		const callback = handle?.getOrCreate(parentKey).onWorkflowFinished;
		if (!callback) return;

		const terminal = terminalResultFromState(c.state);
		if (!terminal) return;
		await callback(parentCallbackName, terminal, c.state.error, c.state.parentToken);
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
					alias: failedStep,
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

	function terminalResultFromState(
		state: WorkflowCoordinatorState,
	): WorkflowExecutionResult | null {
		if (state.status === "completed") {
			return { status: "completed", results: state.stepResults };
		}
		if (state.status === "failed") {
			return {
				status: "failed",
				error: state.error ?? `Workflow "${state.workflowId}" failed`,
				failedStep: state.failedStep ?? undefined,
				results: state.stepResults,
			};
		}
		if (state.status === "cancelled") {
			return { status: "cancelled", results: state.stepResults };
		}
		return null;
	}

	function broadcastTerminal(c: {
		state: WorkflowCoordinatorState;
		broadcast: (name: string, ...args: unknown[]) => void;
	}): void {
		const terminal = terminalResultFromState(c.state);
		if (!terminal) return;
		c.broadcast(WORKFLOW_TERMINAL_EVENT, terminal);
	}

	function nodeAlias(node: PlanNode): string {
		return node.alias;
	}

	function nodeId(node: PlanNode): string {
		return node.id;
	}

	return actor({
		state: {
			status: "pending" as WorkflowCoordinatorState["status"],
			workflowId: "",
			input: {} as unknown,
			stepResults: {} as Record<string, StepResult>,
			nodes: [] as WorkflowCoordinatorState["nodes"],
			currentStepIndex: 0,
			activeStepAlias: null as string | null,
			activeStepActorRef: null as string | null,
			activeStepActorKey: null as string | null,
			activeLoopCoordinatorRef: null as string | null,
			activeLoopCoordinatorKey: null as string | null,
			pendingLoopCallbackName: null as string | null,
			activeParallelAlias: null as string | null,
			activeParallelRef: null as string | null,
			activeParallelKey: null as string | null,
			pendingParallelCallbackName: null as string | null,
			parentRef: null as string | null,
			parentKey: null as string | null,
			parentCallbackName: null as string | null,
			parentToken: 0,
			parentLoopContext: null as LoopContext | null,
			executionToken: 0,
			startedAt: null as number | null,
			completedAt: null as number | null,
			error: null as string | null,
			failedStep: null as string | null,
		},

		actions: {
			run: async (
				c,
				workflowId: string,
				rawInput: unknown = {},
				initialStepResults?: Record<string, StepResult>,
				parentRef?: string,
				parentKey?: string,
				parentCallbackName?: string,
				parentToken?: number,
				parentLoopContext?: LoopContext,
			): Promise<WorkflowExecutionResult> => {
				if (c.state.status === "running") {
					throw new Error("Workflow already running");
				}

				let input: unknown = rawInput;
				if (inputSchema) {
					const parseResult = inputSchema.safeParse(rawInput);
					if (!parseResult.success) {
						c.state.status = "failed";
						c.state.error = `Input validation failed: ${parseResult.error.message}`;
						c.state.failedStep = "__input__";
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, "__input__");
						broadcastTerminal(c);
						return { status: "failed", error: c.state.error };
					}
					input = parseResult.data;
				}

				c.state.status = "running";
				c.state.workflowId = workflowId;
				c.state.input = input;
				c.state.startedAt = Date.now();
				c.state.completedAt = null;
				c.state.stepResults = { ...(initialStepResults ?? {}) };
				c.state.nodes = plan.map((n) => {
					if (n.type === "step" || n.type === "loop" || n.type === "parallel") {
						return { id: n.id, alias: n.alias, type: n.type };
					}
					return { id: nodeId(n), alias: nodeAlias(n), type: "other" };
				});
				c.state.currentStepIndex = 0;
				c.state.activeStepAlias = null;
				c.state.activeStepActorRef = null;
				c.state.activeStepActorKey = null;
				c.state.activeLoopCoordinatorRef = null;
				c.state.activeLoopCoordinatorKey = null;
				c.state.pendingLoopCallbackName = null;
				c.state.activeParallelAlias = null;
				c.state.activeParallelRef = null;
				c.state.activeParallelKey = null;
				c.state.pendingParallelCallbackName = null;
				c.state.parentRef = parentRef ?? null;
				c.state.parentKey = parentKey ?? null;
				c.state.parentCallbackName = parentCallbackName ?? null;
				c.state.parentToken = parentToken ?? 0;
				c.state.parentLoopContext = parentLoopContext ?? null;
				c.state.error = null;
				c.state.failedStep = null;
				c.state.executionToken = nextExecutionToken(c.state.executionToken);

				const nodeNames = plan.map((n) => {
					if (n.type === "step") return n.alias;
					if (n.type === "loop") return `forEach(${n.alias})`;
					return nodeAlias(n);
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
					c.state.activeStepAlias = null;
					c.state.activeStepActorRef = null;
					c.state.activeStepActorKey = null;
					c.state.activeLoopCoordinatorRef = null;
					c.state.activeLoopCoordinatorKey = null;
					c.state.pendingLoopCallbackName = null;
					c.state.activeParallelAlias = null;
					c.state.activeParallelRef = null;
					c.state.activeParallelKey = null;
					c.state.pendingParallelCallbackName = null;
					console.log(`[${workflowName}/${c.state.workflowId}] Workflow completed!`);
					broadcastTerminal(c);
					await notifyParent(c);
					return;
				}

				const node = plan[c.state.currentStepIndex];
				if (!node) {
					c.state.currentStepIndex += 1;
					await c.schedule.after(0, "_continue", token);
					return;
				}

				if (node.type === "step") {
					const rivalClient = getRivalClient(c.client());
					const handle = getStepActorHandle(rivalClient, node.actorRef);
					if (!handle) {
						c.state.stepResults[node.alias] = {
							result: undefined,
							state: {},
							status: "failed",
						};
						c.state.status = "failed";
						c.state.error = `Actor ref "${node.actorRef}" not found in registry`;
						c.state.failedStep = node.alias;
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, node.alias);
						broadcastTerminal(c);
						return;
					}

					const stepKey = `${c.state.workflowId}-${node.id}-${node.alias}`;
					const stepActor = handle.getOrCreate(stepKey);
					const context = buildStepContext({
						input: c.state.input,
						stepResults: c.state.stepResults,
						loopContext: c.state.parentLoopContext ?? undefined,
					});

					c.state.activeStepAlias = node.alias;
					c.state.activeStepActorRef = node.actorRef;
					c.state.activeStepActorKey = stepKey;
					await stepActor.execute(
						context,
						node.config,
						c.state.workflowId,
						node.alias,
						c.name,
						c.state.workflowId,
						token,
					);
					return;
				}

				if (node.type === "loop") {
					const rivalClient = getRivalClient(c.client());
					const handle = getLoopActorHandle(rivalClient, node.loopCoordinatorActorRef);
					if (!handle) {
						c.state.stepResults[node.alias] = {
							result: undefined,
							state: {},
							status: "failed",
						};
						c.state.status = "failed";
						c.state.error = `Loop coordinator ref "${node.loopCoordinatorActorRef}" not found in registry`;
						c.state.failedStep = node.alias;
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, node.alias);
						broadcastTerminal(c);
						return;
					}

					const loopKey = `${c.state.workflowId}-${node.id}-${node.alias}-loop`;
					const callbackName = `${node.id}:${node.alias}:loop:${token}`;
					const loopActor = handle.getOrCreate(loopKey);

					c.state.activeLoopCoordinatorRef = node.loopCoordinatorActorRef;
					c.state.activeLoopCoordinatorKey = loopKey;
					c.state.pendingLoopCallbackName = callbackName;

					await loopActor.runLoop(
						loopKey,
						c.state.workflowId,
						c.state.input,
						c.state.stepResults,
						c.state.parentLoopContext ?? undefined,
						`${node.id}-${node.alias}-`,
						c.name,
						c.state.workflowId,
						callbackName,
						token,
					);
					return;
				}

				if (node.type === "parallel") {
					const rivalClient = getRivalClient(c.client());
					const handle = getParallelActorHandle(rivalClient, node.parallelCoordinatorActorRef);
					if (!handle) {
						c.state.stepResults[node.alias] = {
							result: undefined,
							state: {},
							status: "failed",
						};
						c.state.status = "failed";
						c.state.error = `Parallel coordinator ref "${node.parallelCoordinatorActorRef}" not found in registry`;
						c.state.failedStep = node.alias;
						c.state.completedAt = Date.now();
						await invokeWorkflowOnError(c, c.state.error, node.alias);
						broadcastTerminal(c);
						await notifyParent(c);
						return;
					}

					const parallelKey = `${c.state.workflowId}-${node.id}-${node.alias}-parallel`;
					const callbackName = `${node.id}:${node.alias}:parallel:${token}`;
					const parallelActor = handle.getOrCreate(parallelKey);
					if (node.continueOn === "detached") {
						// Detached mode launches child work and immediately advances.
						// Downstream steps can read this node's kickoff metadata from `steps[alias].result`.
						await parallelActor.runParallel(
							parallelKey,
							c.state.workflowId,
							c.state.input,
							c.state.stepResults,
							c.state.parentLoopContext ?? undefined,
						);
						c.state.stepResults[node.alias] = {
							result: { detached: true, key: parallelKey },
							state: { detached: true },
							status: "completed",
						};
						c.state.currentStepIndex += 1;
						await c.schedule.after(0, "_continue", token);
						return;
					}

					c.state.activeParallelAlias = node.alias;
					c.state.activeParallelRef = node.parallelCoordinatorActorRef;
					c.state.activeParallelKey = parallelKey;
					c.state.pendingParallelCallbackName = callbackName;

					await parallelActor.runParallel(
						parallelKey,
						c.state.workflowId,
						c.state.input,
						c.state.stepResults,
						c.state.parentLoopContext ?? undefined,
						c.name,
						c.state.workflowId,
						callbackName,
						token,
					);
					return;
				}

				c.state.currentStepIndex += 1;
				await c.schedule.after(0, "_continue", token);
			},

			onStepFinished: async (
				c,
				stepAlias: string,
				status: "completed" | "failed" | "skipped" | "cancelled",
				result: unknown,
				error: string | null | undefined,
				stepState: Record<string, unknown>,
				continueOnError?: boolean,
				parentToken?: number,
			): Promise<void> => {
				if (c.state.status !== "running") return;
				if (parentToken !== c.state.executionToken) return;
				if (c.state.activeStepAlias === null || c.state.activeStepAlias !== stepAlias) return;

				c.state.stepResults[stepAlias] = {
					result,
					state: stepState,
					status,
				};

				const stepHardFailed = isHardStepStatus(status, continueOnError);
				c.state.activeStepAlias = null;
				c.state.activeStepActorRef = null;
				c.state.activeStepActorKey = null;

				if (stepHardFailed) {
					c.state.status = "failed";
					c.state.error = error ?? terminalError(status, "Step failed", "Step cancelled");
					c.state.failedStep = stepAlias;
					c.state.completedAt = Date.now();
					await invokeWorkflowOnError(c, c.state.error, stepAlias);
					broadcastTerminal(c);
					await notifyParent(c);
					return;
				}

				c.state.currentStepIndex += 1;
				await c.schedule.after(0, "_continue", c.state.executionToken);
			},

			onLoopFinished: async (
				c,
				callbackName: string,
				status: "completed" | "failed" | "cancelled",
				loopResult: StepResult | null,
				error: string | null | undefined,
				parentToken: number,
			): Promise<void> => {
				if (c.state.status !== "running") return;
				if (parentToken !== c.state.executionToken) return;
				if (!c.state.pendingLoopCallbackName || c.state.pendingLoopCallbackName !== callbackName) {
					return;
				}

				const node = plan[c.state.currentStepIndex];
				if (!node || node.type !== "loop") {
					return;
				}

				c.state.activeLoopCoordinatorRef = null;
				c.state.activeLoopCoordinatorKey = null;
				c.state.pendingLoopCallbackName = null;

				c.state.stepResults[node.alias] =
					loopResult ?? ({ result: undefined, state: {}, status: "failed" } as StepResult);

				if (isHardChildStatus(status)) {
					c.state.status = "failed";
					c.state.error =
						error ??
						terminalError(status, `Loop "${node.alias}" failed`, `Loop "${node.alias}" cancelled`);
					c.state.failedStep = node.alias;
					c.state.completedAt = Date.now();
					await invokeWorkflowOnError(c, c.state.error, node.alias);
					broadcastTerminal(c);
					await notifyParent(c);
					return;
				}

				c.state.currentStepIndex += 1;
				await c.schedule.after(0, "_continue", c.state.executionToken);
			},

			onParallelFinished: async (
				c,
				callbackName: string,
				status: "completed" | "failed" | "cancelled",
				parallelResult: StepResult | null,
				error: string | null | undefined,
				parentToken: number,
			): Promise<void> => {
				if (c.state.status !== "running") return;
				if (parentToken !== c.state.executionToken) return;
				if (
					!c.state.pendingParallelCallbackName ||
					c.state.pendingParallelCallbackName !== callbackName
				) {
					return;
				}

				const node = plan[c.state.currentStepIndex];
				if (!node || node.type !== "parallel") {
					return;
				}

				c.state.activeParallelAlias = null;
				c.state.activeParallelRef = null;
				c.state.activeParallelKey = null;
				c.state.pendingParallelCallbackName = null;

				c.state.stepResults[node.alias] =
					parallelResult ?? ({ result: undefined, state: {}, status: "failed" } as StepResult);

				if (isHardChildStatus(status)) {
					c.state.status = "failed";
					c.state.error =
						error ??
						terminalError(
							status,
							`Concurrent "${node.alias}" failed`,
							`Concurrent "${node.alias}" cancelled`,
						);
					c.state.failedStep = node.alias;
					c.state.completedAt = Date.now();
					await invokeWorkflowOnError(c, c.state.error, node.alias);
					broadcastTerminal(c);
					await notifyParent(c);
					return;
				}

				c.state.currentStepIndex += 1;
				await c.schedule.after(0, "_continue", c.state.executionToken);
			},

			getState: (c): WorkflowCoordinatorState & { duration: number | null } => ({
				status: c.state.status,
				workflowId: c.state.workflowId,
				input: c.state.input,
				stepResults: c.state.stepResults,
				nodes: c.state.nodes,
				currentStepIndex: c.state.currentStepIndex,
				activeStepAlias: c.state.activeStepAlias,
				activeStepActorRef: c.state.activeStepActorRef,
				activeStepActorKey: c.state.activeStepActorKey,
				activeLoopCoordinatorRef: c.state.activeLoopCoordinatorRef,
				activeLoopCoordinatorKey: c.state.activeLoopCoordinatorKey,
				pendingLoopCallbackName: c.state.pendingLoopCallbackName,
				activeParallelAlias: c.state.activeParallelAlias,
				activeParallelRef: c.state.activeParallelRef,
				activeParallelKey: c.state.activeParallelKey,
				pendingParallelCallbackName: c.state.pendingParallelCallbackName,
				parentRef: c.state.parentRef,
				parentKey: c.state.parentKey,
				parentCallbackName: c.state.parentCallbackName,
				parentToken: c.state.parentToken,
				parentLoopContext: c.state.parentLoopContext,
				executionToken: c.state.executionToken,
				startedAt: c.state.startedAt,
				completedAt: c.state.completedAt,
				error: c.state.error,
				failedStep: c.state.failedStep,
				duration:
					c.state.completedAt && c.state.startedAt ? c.state.completedAt - c.state.startedAt : null,
			}),

			cancel: async (c) => {
				if (c.state.status !== "running") {
					return;
				}

				c.state.status = "cancelled";
				c.state.completedAt = Date.now();
				c.state.executionToken = nextExecutionToken(c.state.executionToken);

				const activeStepRef = c.state.activeStepActorRef;
				const activeStepKey = c.state.activeStepActorKey;
				const activeLoopRef = c.state.activeLoopCoordinatorRef;
				const activeLoopKey = c.state.activeLoopCoordinatorKey;
				const activeParallelRef = c.state.activeParallelRef;
				const activeParallelKey = c.state.activeParallelKey;
				c.state.activeStepAlias = null;
				c.state.activeStepActorRef = null;
				c.state.activeStepActorKey = null;
				c.state.activeLoopCoordinatorRef = null;
				c.state.activeLoopCoordinatorKey = null;
				c.state.pendingLoopCallbackName = null;
				c.state.activeParallelAlias = null;
				c.state.activeParallelRef = null;
				c.state.activeParallelKey = null;
				c.state.pendingParallelCallbackName = null;

				const rivalClient = getRivalClient(c.client());
				await propagateStepCancel(
					rivalClient,
					activeStepRef && activeStepKey ? [{ ref: activeStepRef, key: activeStepKey }] : [],
					getStepActorHandle,
					(_target, err) => {
						console.warn(
							`[${workflowName}/${c.state.workflowId}] Cancel propagation to step failed:`,
							err,
						);
					},
				);
				await propagateLoopCancel(
					rivalClient,
					activeLoopRef && activeLoopKey ? [{ ref: activeLoopRef, key: activeLoopKey }] : [],
					getLoopActorHandle,
					(_target, err) => {
						console.warn(
							`[${workflowName}/${c.state.workflowId}] Cancel propagation to loop failed:`,
							err,
						);
					},
				);
				await propagateParallelCancel(
					rivalClient,
					activeParallelRef && activeParallelKey
						? [{ ref: activeParallelRef, key: activeParallelKey }]
						: [],
					getParallelActorHandle,
					(_target, err) => {
						console.warn(
							`[${workflowName}/${c.state.workflowId}] Cancel propagation to concurrent failed:`,
							err,
						);
					},
				);

				console.log(`[${workflowName}/${c.state.workflowId}] Workflow cancelled`);
				broadcastTerminal(c);
				await notifyParent(c);
			},
		},
	});
}
