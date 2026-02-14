import { actor } from "rivetkit";
import type { LoopContext, ParallelPlanNode, StepResult } from "../types";
import type { ActiveActorAddress, RunningKickoffResult, WorkflowRunResult } from "./actor-handles";
import {
	getLoopActorHandle,
	getParallelActorHandle,
	getStepActorHandle,
	getWorkflowActorHandle,
} from "./actor-handles";
import { buildStepContext } from "./context-builder";
import {
	propagateLoopCancel,
	propagateParallelCancel,
	propagateStepCancel,
	propagateWorkflowCancel,
} from "./orchestration/cancel";
import {
	isHardChildStatus,
	isHardStepStatus,
	isHardWorkflowResultStatus,
	terminalError,
} from "./orchestration/policy";
import { nextExecutionToken } from "./orchestration/tokens";

export interface ParallelCoordinatorState {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	selfKey: string;
	workflowId: string;
	input: unknown;
	parentStepResults: Record<string, StepResult>;
	parentLoopContext: LoopContext | null;
	parentRef: string | null;
	parentKey: string | null;
	parentCallbackName: string | null;
	parentToken: number;
	executionToken: number;
	startedAt: number | null;
	completedAt: number | null;
	error: string | null;
	parallelResult: StepResult | null;
	nextIndex: number;
	stepOrder: string[];
	inFlight: Record<string, InFlightRuntime>;
	results: Record<string, StepResult>;
	hardFailure: boolean;
	firstHardFailureError: string | null;
	activeStepActors: Record<string, ActiveActorAddress>;
	activeChildLoops: Record<string, ActiveActorAddress>;
	activeChildParallels: Record<string, ActiveActorAddress>;
	activeChildWorkflows: Record<string, ActiveActorAddress>;
}

interface InFlightRuntime {
	alias: string;
	type: "step" | "loop" | "parallel" | "workflow";
}

export type ParallelExecutionKickoffResult = RunningKickoffResult;

function toFailedStepResult(): StepResult {
	return { result: undefined, state: {}, status: "failed" };
}

export function createParallelCoordinator(_workflowName: string, node: ParallelPlanNode) {
	const maxDispatchPerTick = 25;

	async function notifyParent(c: {
		state: ParallelCoordinatorState;
		client: () => Record<string, unknown>;
	}) {
		const parentRef = c.state.parentRef;
		const parentKey = c.state.parentKey;
		const parentCallbackName = c.state.parentCallbackName;
		if (!parentRef || !parentKey || !parentCallbackName) return;

		const parentType = c.client()[parentRef] as
			| {
					getOrCreate: (key: string) => {
						onParallelFinished?: (...args: unknown[]) => Promise<void>;
					};
			  }
			| undefined;
		const callback = parentType?.getOrCreate(parentKey).onParallelFinished;
		if (!callback) return;
		await callback(
			parentCallbackName,
			c.state.status,
			c.state.parallelResult,
			c.state.error,
			c.state.parentToken,
		);
	}

	function orderedResults(c: {
		state: ParallelCoordinatorState;
	}): Record<string, StepResult> {
		const ordered: Record<string, StepResult> = {};
		for (const alias of c.state.stepOrder) {
			if (alias in c.state.results) {
				ordered[alias] = c.state.results[alias] as StepResult;
			}
		}
		return ordered;
	}

	async function finalize(
		c: {
			state: ParallelCoordinatorState;
			client: () => Record<string, unknown>;
		},
		status: "completed" | "failed" | "cancelled",
		error?: string,
	): Promise<void> {
		c.state.status = status;
		c.state.completedAt = Date.now();
		c.state.error = error ?? null;
		c.state.activeStepActors = {};
		c.state.activeChildLoops = {};
		c.state.activeChildParallels = {};
		c.state.activeChildWorkflows = {};
		c.state.inFlight = {};

		c.state.parallelResult = {
			result: orderedResults(c),
			state: {},
			status,
		};
		await notifyParent(c);
	}

	function recordHardFailure(c: { state: ParallelCoordinatorState }, error: string): void {
		c.state.hardFailure = true;
		c.state.firstHardFailureError ??= error;
	}

	function consumeInFlight(
		c: { state: ParallelCoordinatorState },
		callbackName: string,
		expectedType: InFlightRuntime["type"],
	): InFlightRuntime | null {
		const runtime = c.state.inFlight[callbackName];
		if (!runtime || runtime.type !== expectedType) return null;
		delete c.state.inFlight[callbackName];
		return runtime;
	}

	return actor({
		state: {
			status: "pending" as ParallelCoordinatorState["status"],
			selfKey: "",
			workflowId: "",
			input: {} as unknown,
			parentStepResults: {} as Record<string, StepResult>,
			parentLoopContext: null as LoopContext | null,
			parentRef: null as string | null,
			parentKey: null as string | null,
			parentCallbackName: null as string | null,
			parentToken: 0,
			executionToken: 0,
			startedAt: null as number | null,
			completedAt: null as number | null,
			error: null as string | null,
			parallelResult: null as StepResult | null,
			nextIndex: 0,
			stepOrder: [] as string[],
			inFlight: {} as Record<string, InFlightRuntime>,
			results: {} as Record<string, StepResult>,
			hardFailure: false,
			firstHardFailureError: null as string | null,
			activeStepActors: {} as Record<string, ActiveActorAddress>,
			activeChildLoops: {} as Record<string, ActiveActorAddress>,
			activeChildParallels: {} as Record<string, ActiveActorAddress>,
			activeChildWorkflows: {} as Record<string, ActiveActorAddress>,
		},
		actions: {
			runParallel: async (
				c,
				selfKey: string,
				workflowId: string,
				input: unknown,
				parentStepResults: Record<string, StepResult>,
				parentLoopContext: LoopContext | undefined,
				parentRef?: string,
				parentKey?: string,
				parentCallbackName?: string,
				parentToken?: number,
			): Promise<ParallelExecutionKickoffResult> => {
				const token = nextExecutionToken(c.state.executionToken);
				c.state.status = "running";
				c.state.selfKey = selfKey;
				c.state.workflowId = workflowId;
				c.state.input = input;
				c.state.parentStepResults = { ...parentStepResults };
				c.state.parentLoopContext = parentLoopContext ?? null;
				c.state.parentRef = parentRef ?? null;
				c.state.parentKey = parentKey ?? null;
				c.state.parentCallbackName = parentCallbackName ?? null;
				c.state.parentToken = parentToken ?? 0;
				c.state.executionToken = token;
				c.state.startedAt = Date.now();
				c.state.completedAt = null;
				c.state.error = null;
				c.state.parallelResult = null;
				c.state.nextIndex = 0;
				c.state.stepOrder = node.steps.map((n) => n.alias);
				c.state.inFlight = {};
				c.state.results = {};
				c.state.hardFailure = false;
				c.state.firstHardFailureError = null;
				c.state.activeStepActors = {};
				c.state.activeChildLoops = {};
				c.state.activeChildParallels = {};
				c.state.activeChildWorkflows = {};
				await c.schedule.after(0, "_continue", token);
				return { status: "running" };
			},

			_continue: async (c, token: number): Promise<void> => {
				if (c.state.executionToken !== token || c.state.status !== "running") return;

				let dispatched = 0;
				while (
					dispatched < maxDispatchPerTick &&
					c.state.nextIndex < node.steps.length &&
					!(c.state.hardFailure && (node.onFailure ?? "fail") === "fail")
				) {
					const child = node.steps[c.state.nextIndex];
					c.state.nextIndex += 1;
					if (!child) continue;

					const childAlias = child.alias;
					const childId = child.id;
					const client = c.client() as Record<string, unknown>;
					const callbackBase = `${node.id}:${node.alias}:${childId}:${childAlias}:${token}`;

					if (child.type === "step") {
						const stepHandle = getStepActorHandle(client, child.actorRef);
						if (!stepHandle) {
							c.state.results[childAlias] = toFailedStepResult();
							recordHardFailure(c, `Actor ref "${child.actorRef}" not found in registry`);
							continue;
						}

						const stepKey = `${c.state.selfKey}-${childId}-${childAlias}-step`;
						const callbackName = `${callbackBase}:step`;
						const stepActor = stepHandle.getOrCreate(stepKey);
						const context = buildStepContext({
							input: c.state.input,
							stepResults: c.state.parentStepResults,
							loopContext: c.state.parentLoopContext ?? undefined,
						});
						c.state.inFlight[callbackName] = {
							alias: childAlias,
							type: "step",
						};
						c.state.activeStepActors[callbackName] = {
							ref: child.actorRef,
							key: stepKey,
						};
						await stepActor.execute(
							context,
							child.config,
							c.state.workflowId,
							callbackName,
							c.name,
							c.state.selfKey,
							token,
						);
						dispatched += 1;
						continue;
					}

					if (child.type === "loop") {
						const loopHandle = getLoopActorHandle(client, child.loopCoordinatorActorRef);
						if (!loopHandle) {
							c.state.results[childAlias] = toFailedStepResult();
							recordHardFailure(
								c,
								`Loop coordinator ref "${child.loopCoordinatorActorRef}" not found in registry`,
							);
							continue;
						}

						const loopKey = `${c.state.selfKey}-${childId}-${childAlias}-loop`;
						const callbackName = `${callbackBase}:loop`;
						c.state.inFlight[callbackName] = {
							alias: childAlias,
							type: "loop",
						};
						c.state.activeChildLoops[callbackName] = {
							ref: child.loopCoordinatorActorRef,
							key: loopKey,
						};
						await loopHandle
							.getOrCreate(loopKey)
							.runLoop(
								loopKey,
								c.state.workflowId,
								c.state.input,
								c.state.parentStepResults,
								c.state.parentLoopContext ?? undefined,
								`${node.id}-${node.alias}-${childId}-${childAlias}-`,
								c.name,
								c.state.selfKey,
								callbackName,
								token,
							);
						dispatched += 1;
						continue;
					}

					if (child.type === "parallel") {
						const parallelHandle = getParallelActorHandle(
							client,
							child.parallelCoordinatorActorRef,
						);
						if (!parallelHandle) {
							c.state.results[childAlias] = toFailedStepResult();
							recordHardFailure(
								c,
								`Parallel coordinator ref "${child.parallelCoordinatorActorRef}" not found in registry`,
							);
							continue;
						}

						const parallelKey = `${c.state.selfKey}-${childId}-${childAlias}-parallel`;
						const callbackName = `${callbackBase}:parallel`;
						if (child.continueOn === "detached") {
							await parallelHandle
								.getOrCreate(parallelKey)
								.runParallel(
									parallelKey,
									c.state.workflowId,
									c.state.input,
									c.state.parentStepResults,
									c.state.parentLoopContext ?? undefined,
								);
							c.state.results[childAlias] = {
								result: { detached: true, key: parallelKey },
								state: { detached: true },
								status: "completed",
							};
						} else {
							c.state.inFlight[callbackName] = {
								alias: childAlias,
								type: "parallel",
							};
							c.state.activeChildParallels[callbackName] = {
								ref: child.parallelCoordinatorActorRef,
								key: parallelKey,
							};
							await parallelHandle
								.getOrCreate(parallelKey)
								.runParallel(
									parallelKey,
									c.state.workflowId,
									c.state.input,
									c.state.parentStepResults,
									c.state.parentLoopContext ?? undefined,
									c.name,
									c.state.selfKey,
									callbackName,
									token,
								);
						}
						dispatched += 1;
						continue;
					}

					if (child.type === "workflow") {
						const workflowHandle = getWorkflowActorHandle(client, child.coordinatorActorRef);
						if (!workflowHandle) {
							c.state.results[childAlias] = toFailedStepResult();
							recordHardFailure(
								c,
								`Workflow coordinator ref "${child.coordinatorActorRef}" not found in registry`,
							);
							continue;
						}

						const workflowKey = `${c.state.selfKey}-${childId}-${childAlias}-workflow`;
						const callbackName = `${callbackBase}:workflow`;
						c.state.inFlight[callbackName] = {
							alias: childAlias,
							type: "workflow",
						};
						c.state.activeChildWorkflows[callbackName] = {
							ref: child.coordinatorActorRef,
							key: workflowKey,
						};
						await workflowHandle
							.getOrCreate(workflowKey)
							.run(
								workflowKey,
								c.state.input,
								c.state.parentStepResults,
								c.name,
								c.state.selfKey,
								callbackName,
								token,
								c.state.parentLoopContext ?? undefined,
							);
						dispatched += 1;
						continue;
					}

					c.state.results[childAlias] = toFailedStepResult();
					recordHardFailure(
						c,
						`Unsupported node type "${child.type}" in concurrent "${node.alias}"`,
					);
				}

				if (Object.keys(c.state.inFlight).length > 0) return;

				if (c.state.hardFailure && (node.onFailure ?? "fail") === "fail") {
					await finalize(
						c,
						"failed",
						c.state.firstHardFailureError ?? `Concurrent "${node.alias}" failed`,
					);
					return;
				}

				if (c.state.nextIndex < node.steps.length) {
					await c.schedule.after(0, "_continue", token);
					return;
				}

				await finalize(c, "completed");
			},

			onStepFinished: async (
				c,
				stepName: string,
				status: "completed" | "failed" | "skipped" | "cancelled",
				result: unknown,
				error: string | null | undefined,
				stepState: Record<string, unknown>,
				continueOnError?: boolean,
				parentToken?: number,
			): Promise<void> => {
				if (c.state.status !== "running") return;
				if (parentToken !== c.state.executionToken) return;
				const runtime = consumeInFlight(c, stepName, "step");
				if (!runtime) return;
				delete c.state.activeStepActors[stepName];

				c.state.results[runtime.alias] = {
					result,
					state: stepState,
					status,
				};
				if (isHardStepStatus(status, continueOnError)) {
					recordHardFailure(c, error ?? terminalError(status, "Step failed", "Step cancelled"));
				}
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
				const runtime = consumeInFlight(c, callbackName, "loop");
				if (!runtime) return;
				delete c.state.activeChildLoops[callbackName];

				c.state.results[runtime.alias] = loopResult ?? toFailedStepResult();
				if (isHardChildStatus(status)) {
					recordHardFailure(c, error ?? terminalError(status, "Loop failed", "Loop cancelled"));
				}
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
				const runtime = consumeInFlight(c, callbackName, "parallel");
				if (!runtime) return;
				delete c.state.activeChildParallels[callbackName];

				c.state.results[runtime.alias] = parallelResult ?? toFailedStepResult();
				if (isHardChildStatus(status)) {
					recordHardFailure(
						c,
						error ??
							terminalError(status, "Nested concurrent failed", "Nested concurrent cancelled"),
					);
				}
				await c.schedule.after(0, "_continue", c.state.executionToken);
			},

			onWorkflowFinished: async (
				c,
				callbackName: string,
				workflowResult: WorkflowRunResult,
				error: string | null | undefined,
				parentToken: number,
			): Promise<void> => {
				if (c.state.status !== "running") return;
				if (parentToken !== c.state.executionToken) return;
				const runtime = consumeInFlight(c, callbackName, "workflow");
				if (!runtime) return;
				delete c.state.activeChildWorkflows[callbackName];

				c.state.results[runtime.alias] = {
					result: workflowResult.results ?? {},
					state: {},
					status: workflowResult.status,
				};
				if (isHardWorkflowResultStatus(workflowResult.status)) {
					recordHardFailure(
						c,
						error ??
							workflowResult.error ??
							terminalError(
								workflowResult.status,
								"Workflow branch failed",
								"Workflow branch cancelled",
							),
					);
				}
				await c.schedule.after(0, "_continue", c.state.executionToken);
			},

			cancel: async (c): Promise<void> => {
				if (c.state.status !== "running") return;

				c.state.status = "cancelled";
				c.state.completedAt = Date.now();
				c.state.executionToken = nextExecutionToken(c.state.executionToken);

				const activeSteps = Object.values(c.state.activeStepActors);
				const activeLoops = Object.values(c.state.activeChildLoops);
				const activeParallels = Object.values(c.state.activeChildParallels);
				const activeWorkflows = Object.values(c.state.activeChildWorkflows);

				c.state.activeStepActors = {};
				c.state.activeChildLoops = {};
				c.state.activeChildParallels = {};
				c.state.activeChildWorkflows = {};
				c.state.inFlight = {};

				const client = c.client() as Record<string, unknown>;
				await propagateStepCancel(client, activeSteps, getStepActorHandle, (_target, err) => {
					console.warn(
						`[${node.alias}/${c.state.workflowId}] Cancel propagation to step failed:`,
						err,
					);
				});
				await propagateLoopCancel(client, activeLoops, getLoopActorHandle, (_target, err) => {
					console.warn(
						`[${node.alias}/${c.state.workflowId}] Cancel propagation to loop failed:`,
						err,
					);
				});
				await propagateParallelCancel(
					client,
					activeParallels,
					getParallelActorHandle,
					(_target, err) => {
						console.warn(
							`[${node.alias}/${c.state.workflowId}] Cancel propagation to concurrent failed:`,
							err,
						);
					},
				);
				await propagateWorkflowCancel(
					client,
					activeWorkflows,
					getWorkflowActorHandle,
					(_target, err) => {
						console.warn(
							`[${node.alias}/${c.state.workflowId}] Cancel propagation to workflow failed:`,
							err,
						);
					},
				);

				await finalize(c, "cancelled", "Concurrent cancelled");
			},

			getState: (c): ParallelCoordinatorState & { duration: number | null } => ({
				status: c.state.status,
				selfKey: c.state.selfKey,
				workflowId: c.state.workflowId,
				input: c.state.input,
				parentStepResults: c.state.parentStepResults,
				parentLoopContext: c.state.parentLoopContext,
				parentRef: c.state.parentRef,
				parentKey: c.state.parentKey,
				parentCallbackName: c.state.parentCallbackName,
				parentToken: c.state.parentToken,
				executionToken: c.state.executionToken,
				startedAt: c.state.startedAt,
				completedAt: c.state.completedAt,
				error: c.state.error,
				parallelResult: c.state.parallelResult,
				nextIndex: c.state.nextIndex,
				stepOrder: c.state.stepOrder,
				inFlight: c.state.inFlight,
				results: c.state.results,
				hardFailure: c.state.hardFailure,
				firstHardFailureError: c.state.firstHardFailureError,
				activeStepActors: c.state.activeStepActors,
				activeChildLoops: c.state.activeChildLoops,
				activeChildParallels: c.state.activeChildParallels,
				activeChildWorkflows: c.state.activeChildWorkflows,
				duration:
					c.state.completedAt && c.state.startedAt ? c.state.completedAt - c.state.startedAt : null,
			}),
		},
	});
}
