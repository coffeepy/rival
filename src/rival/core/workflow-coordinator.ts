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
import { buildStepContext } from "./context-builder";
import type { ExecuteContext, StepExecutionKickoffResult } from "./step-actor";

/**
 * Workflow coordinator state.
 */
export interface WorkflowCoordinatorState {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	workflowId: string;
	input: unknown;
	stepResults: Record<string, StepResult>;
	nodes: Array<{ id: string; alias: string; type: "step" | "loop" | "other" }>;
	currentStepIndex: number;
	activeStepAlias: string | null;
	activeStepActorRef: string | null;
	activeStepActorKey: string | null;
	activeLoopCoordinatorRef: string | null;
	activeLoopCoordinatorKey: string | null;
	pendingLoopCallbackName: string | null;
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
			coordinatorToken?: number,
		) => Promise<StepExecutionKickoffResult>;
		cancel: () => Promise<void>;
	};
};

type LoopActorHandle = {
	getOrCreate: (key: string) => {
		runLoop: (
			selfKey: string,
			workflowId: string,
			input: unknown,
			parentStepResults: Record<string, StepResult>,
			parentLoopContext: LoopContext | undefined,
			loopKeyPrefix: string,
			parentRef: string,
			parentKey: string,
			parentCallbackName: string,
			parentToken: number,
		) => Promise<{ status: "running" }>;
		cancel: () => Promise<void>;
	};
};

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

	const result = planSchema.safeParse(plan);
	if (!result.success) {
		const messages = result.error.issues.map((i) => i.message).join("; ");
		throw new Error(`Workflow "${workflowName}" has an invalid plan: ${messages}`);
	}

	function getStepActorHandle(
		client: Record<string, unknown>,
		actorRef: string,
	): StepActorHandle | undefined {
		return client[actorRef] as StepActorHandle | undefined;
	}

	function getLoopActorHandle(
		client: Record<string, unknown>,
		actorRef: string,
	): LoopActorHandle | undefined {
		return client[actorRef] as LoopActorHandle | undefined;
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
		if (node.type === "step" || node.type === "loop" || node.type === "branch") {
			return node.alias;
		}
		return node.name ?? node.type;
	}

	function nodeId(node: PlanNode): string {
		if (node.type === "step" || node.type === "loop" || node.type === "branch") {
			return node.id;
		}
		return node.name ?? node.type;
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
				c.state.stepResults = {};
				c.state.nodes = plan.map((n) => {
					if (n.type === "step" || n.type === "loop") {
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
					console.log(`[${workflowName}/${c.state.workflowId}] Workflow completed!`);
					broadcastTerminal(c);
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
					const client = c.client() as Record<string, unknown>;
					const handle = getLoopActorHandle(client, node.loopCoordinatorActorRef);
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
						undefined,
						`${node.id}-${node.alias}-`,
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

				const stepHardFailed = status === "failed" && !continueOnError;
				c.state.activeStepAlias = null;
				c.state.activeStepActorRef = null;
				c.state.activeStepActorKey = null;

				if (stepHardFailed) {
					c.state.status = "failed";
					c.state.error = error ?? "Step failed";
					c.state.failedStep = stepAlias;
					c.state.completedAt = Date.now();
					await invokeWorkflowOnError(c, c.state.error, stepAlias);
					broadcastTerminal(c);
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

				if (status === "failed") {
					c.state.status = "failed";
					c.state.error = error ?? `Loop "${node.alias}" failed`;
					c.state.failedStep = node.alias;
					c.state.completedAt = Date.now();
					await invokeWorkflowOnError(c, c.state.error, node.alias);
					broadcastTerminal(c);
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
				c.state.activeStepAlias = null;
				c.state.activeStepActorRef = null;
				c.state.activeStepActorKey = null;
				c.state.activeLoopCoordinatorRef = null;
				c.state.activeLoopCoordinatorKey = null;
				c.state.pendingLoopCallbackName = null;

				const client = c.client() as Record<string, unknown>;
				if (activeStepRef && activeStepKey) {
					try {
						const stepHandle = getStepActorHandle(client, activeStepRef);
						if (stepHandle) {
							await stepHandle.getOrCreate(activeStepKey).cancel();
						}
					} catch (err) {
						console.warn(
							`[${workflowName}/${c.state.workflowId}] Cancel propagation to step failed:`,
							err,
						);
					}
				}

				if (activeLoopRef && activeLoopKey) {
					try {
						const loopHandle = getLoopActorHandle(client, activeLoopRef);
						if (loopHandle) {
							await loopHandle.getOrCreate(activeLoopKey).cancel();
						}
					} catch (err) {
						console.warn(
							`[${workflowName}/${c.state.workflowId}] Cancel propagation to loop failed:`,
							err,
						);
					}
				}

				console.log(`[${workflowName}/${c.state.workflowId}] Workflow cancelled`);
				broadcastTerminal(c);
			},
		},
	});
}
