import { actor } from "rivetkit";
import type { LoopContext, LoopPlanNode, StepResult } from "../types";
import type { ActiveActorAddress, RunningKickoffResult } from "./actor-handles";
import { getLoopActorHandle, getParallelActorHandle, getStepActorHandle } from "./actor-handles";
import { buildStepContext } from "./context-builder";
import {
	propagateLoopCancel,
	propagateParallelCancel,
	propagateStepCancel,
} from "./orchestration/cancel";
import { isHardChildStatus, isHardStepStatus, terminalError } from "./orchestration/policy";
import { nextExecutionToken } from "./orchestration/tokens";

export type LoopExecutionKickoffResult = RunningKickoffResult;

export interface LoopCoordinatorState {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	selfKey: string;
	workflowId: string;
	input: unknown;
	mode: "sequential" | "parallel";
	concurrency: number;
	loopKeyPrefix: string;
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
	loopResult: StepResult | null;
	iteratorPending: boolean;
	iteratorCallbackName: string | null;
	items: unknown[];
	nextIndex: number;
	completedCount: number;
	iterations: IterationResult[];
	inFlight: Record<string, IterationRuntime>;
	hardFailure: boolean;
	firstHardFailureError: string | null;
	activeStepActors: Record<string, ActiveActorAddress>;
	activeChildLoops: Record<string, ActiveActorAddress>;
	activeChildParallels: Record<string, ActiveActorAddress>;
}

interface IterationResult {
	item: unknown;
	index: number;
	results: Record<string, StepResult>;
}

interface IterationRuntime {
	index: number;
	nodeIndex: number;
	stepResults: Record<string, StepResult>;
	pendingType: "step" | "loop" | "parallel" | null;
	pendingCallbackName: string | null;
	pendingNodeName: string | null;
}

function toFailedStepResult(): StepResult {
	return { result: undefined, state: {}, status: "failed" };
}

export function createForLoopCoordinator(_workflowName: string, node: LoopPlanNode) {
	const defaultConcurrency = Number.MAX_SAFE_INTEGER;
	const maxDispatchPerTick = 25;

	async function notifyParent(c: {
		state: LoopCoordinatorState;
		client: () => Record<string, unknown>;
	}) {
		const parentRef = c.state.parentRef;
		const parentKey = c.state.parentKey;
		const parentCallbackName = c.state.parentCallbackName;
		if (!parentRef || !parentKey || !parentCallbackName) return;

		const parentType = c.client()[parentRef] as
			| {
					getOrCreate: (key: string) => {
						onLoopFinished?: (...args: unknown[]) => Promise<void>;
					};
			  }
			| undefined;
		const callback = parentType?.getOrCreate(parentKey).onLoopFinished;
		if (!callback) {
			console.warn(
				`[${node.alias}/${c.state.workflowId}] Parent callback not found: ${parentRef}/${parentKey}`,
			);
			return;
		}

		await callback(
			parentCallbackName,
			c.state.status,
			c.state.loopResult,
			c.state.error,
			c.state.parentToken,
		);
	}

	function completeIteration(
		c: { state: LoopCoordinatorState },
		runtime: IterationRuntime,
		hardFailure: boolean,
		error?: string,
	): void {
		c.state.iterations.push({
			item: c.state.items[runtime.index],
			index: runtime.index,
			results: runtime.stepResults,
		});

		delete c.state.inFlight[String(runtime.index)];
		c.state.completedCount += 1;

		if (hardFailure) {
			c.state.hardFailure = true;
			c.state.firstHardFailureError ??= error ?? "Loop iteration failed";
			if (c.state.mode === "sequential") {
				c.state.nextIndex = c.state.items.length;
			}
		}
	}

	async function finalizeLoop(
		c: {
			state: LoopCoordinatorState;
			client: () => Record<string, unknown>;
		},
		status: "completed" | "failed" | "cancelled",
		error?: string,
	): Promise<void> {
		c.state.status = status;
		c.state.completedAt = Date.now();
		c.state.error = error ?? null;
		c.state.iteratorPending = false;
		c.state.iteratorCallbackName = null;
		c.state.activeStepActors = {};
		c.state.activeChildLoops = {};
		c.state.activeChildParallels = {};

		const iterations = [...c.state.iterations].sort((a, b) => a.index - b.index);
		c.state.loopResult = {
			result: { iterations },
			state: {},
			status,
		};

		await notifyParent(c);
	}

	return actor({
		state: {
			status: "pending" as LoopCoordinatorState["status"],
			selfKey: "",
			workflowId: "",
			input: {} as unknown,
			mode: (node.parallel ? "parallel" : "sequential") as LoopCoordinatorState["mode"],
			concurrency: node.concurrency ?? defaultConcurrency,
			loopKeyPrefix: "",
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
			loopResult: null as StepResult | null,
			iteratorPending: false,
			iteratorCallbackName: null as string | null,
			items: [] as unknown[],
			nextIndex: 0,
			completedCount: 0,
			iterations: [] as IterationResult[],
			inFlight: {} as Record<string, IterationRuntime>,
			hardFailure: false,
			firstHardFailureError: null as string | null,
			activeStepActors: {} as Record<string, ActiveActorAddress>,
			activeChildLoops: {} as Record<string, ActiveActorAddress>,
			activeChildParallels: {} as Record<string, ActiveActorAddress>,
		},
		actions: {
			runLoop: async (
				c,
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
			): Promise<LoopExecutionKickoffResult> => {
				const token = nextExecutionToken(c.state.executionToken);
				c.state.status = "running";
				c.state.selfKey = selfKey;
				c.state.workflowId = workflowId;
				c.state.input = input;
				c.state.mode = (node.parallel ? "parallel" : "sequential") as LoopCoordinatorState["mode"];
				c.state.concurrency = node.concurrency ?? defaultConcurrency;
				c.state.loopKeyPrefix = loopKeyPrefix;
				c.state.parentStepResults = { ...parentStepResults };
				c.state.parentLoopContext = parentLoopContext ?? null;
				c.state.parentRef = parentRef;
				c.state.parentKey = parentKey;
				c.state.parentCallbackName = parentCallbackName;
				c.state.parentToken = parentToken;
				c.state.executionToken = token;
				c.state.startedAt = Date.now();
				c.state.completedAt = null;
				c.state.error = null;
				c.state.loopResult = null;
				c.state.iteratorPending = false;
				c.state.iteratorCallbackName = null;
				c.state.items = [];
				c.state.nextIndex = 0;
				c.state.completedCount = 0;
				c.state.iterations = [];
				c.state.inFlight = {};
				c.state.hardFailure = false;
				c.state.firstHardFailureError = null;
				c.state.activeStepActors = {};
				c.state.activeChildLoops = {};
				c.state.activeChildParallels = {};

				const client = c.client() as Record<string, unknown>;
				const iteratorHandle = getStepActorHandle(client, node.iteratorActorRef);
				if (!iteratorHandle) {
					await finalizeLoop(
						c,
						"failed",
						`Iterator actor ref "${node.iteratorActorRef}" not found in registry`,
					);
					return { status: "running" };
				}

				const iteratorKey = `${workflowId}-${loopKeyPrefix}iterator`;
				const iteratorActor = iteratorHandle.getOrCreate(iteratorKey);
				const iteratorCallbackName = `${node.id}:${node.alias}:iterator:${token}`;
				const iteratorContext = buildStepContext({
					input,
					stepResults: c.state.parentStepResults,
					loopContext: c.state.parentLoopContext ?? undefined,
				});

				c.state.iteratorPending = true;
				c.state.iteratorCallbackName = iteratorCallbackName;
				c.state.activeStepActors[iteratorCallbackName] = {
					ref: node.iteratorActorRef,
					key: iteratorKey,
				};

				await iteratorActor.execute(
					iteratorContext,
					undefined,
					workflowId,
					iteratorCallbackName,
					c.name,
					selfKey,
					token,
				);

				return { status: "running" };
			},

			_continue: async (c, token: number): Promise<void> => {
				if (c.state.executionToken !== token || c.state.status !== "running") return;
				if (c.state.iteratorPending) return;

				if (c.state.items.length === 0) {
					await finalizeLoop(c, "completed");
					return;
				}

				const limit = c.state.mode === "parallel" ? c.state.concurrency : 1;
				let dispatched = 0;
				let progressed = false;

				const inFlightKeys = Object.keys(c.state.inFlight)
					.map((k) => Number(k))
					.sort((a, b) => a - b);

				for (const idx of inFlightKeys) {
					if (dispatched >= maxDispatchPerTick) break;
					const runtime = c.state.inFlight[String(idx)];
					if (!runtime || runtime.pendingType) continue;

					if (runtime.nodeIndex >= node.run.length) {
						completeIteration(c, runtime, false);
						progressed = true;
						continue;
					}

					const currentNode = node.run[runtime.nodeIndex];
					if (!currentNode) {
						runtime.nodeIndex += 1;
						c.state.inFlight[String(idx)] = runtime;
						progressed = true;
						continue;
					}
					const currentNodeAlias = currentNode.alias;
					const currentNodeId = currentNode.id;

					const loopContext: LoopContext = {
						item: c.state.items[runtime.index],
						index: runtime.index,
						items: c.state.items,
					};
					const mergedStepResults = {
						...c.state.parentStepResults,
						...runtime.stepResults,
					};

					if (currentNode.type === "step") {
						const client = c.client() as Record<string, unknown>;
						const stepHandle = getStepActorHandle(client, currentNode.actorRef);
						if (!stepHandle) {
							runtime.stepResults[currentNodeAlias] = toFailedStepResult();
							completeIteration(
								c,
								runtime,
								true,
								`Actor ref "${currentNode.actorRef}" not found in registry`,
							);
							progressed = true;
							continue;
						}

						const stepKey = `${c.state.workflowId}-${c.state.loopKeyPrefix}iter${runtime.index}-${currentNodeId}-${currentNodeAlias}`;
						const callbackName = `${node.id}:${node.alias}:iter${runtime.index}:node${runtime.nodeIndex}:${currentNodeId}:${currentNodeAlias}:${token}`;
						const stepActor = stepHandle.getOrCreate(stepKey);
						const stepContext = buildStepContext({
							input: c.state.input,
							stepResults: mergedStepResults,
							loopContext,
						});

						runtime.pendingType = "step";
						runtime.pendingCallbackName = callbackName;
						runtime.pendingNodeName = currentNodeAlias;
						c.state.inFlight[String(idx)] = runtime;
						c.state.activeStepActors[callbackName] = { ref: currentNode.actorRef, key: stepKey };

						await stepActor.execute(
							stepContext,
							currentNode.config,
							c.state.workflowId,
							callbackName,
							c.name,
							c.state.selfKey,
							token,
						);
						dispatched += 1;
						progressed = true;
						continue;
					}

					if (currentNode.type === "loop") {
						const client = c.client() as Record<string, unknown>;
						const childHandle = getLoopActorHandle(client, currentNode.loopCoordinatorActorRef);
						if (!childHandle) {
							runtime.stepResults[currentNodeAlias] = toFailedStepResult();
							completeIteration(
								c,
								runtime,
								true,
								`Loop coordinator ref "${currentNode.loopCoordinatorActorRef}" not found in registry`,
							);
							progressed = true;
							continue;
						}

						const childKey = `${c.state.workflowId}-${c.state.loopKeyPrefix}iter${runtime.index}-${currentNodeId}-${currentNodeAlias}-loop`;
						const callbackName = `${node.id}:${node.alias}:iter${runtime.index}:node${runtime.nodeIndex}:${currentNodeId}:${currentNodeAlias}:loop:${token}`;
						const childLoop = childHandle.getOrCreate(childKey);

						runtime.pendingType = "loop";
						runtime.pendingCallbackName = callbackName;
						runtime.pendingNodeName = currentNodeAlias;
						c.state.inFlight[String(idx)] = runtime;
						c.state.activeChildLoops[callbackName] = {
							ref: currentNode.loopCoordinatorActorRef,
							key: childKey,
						};

						await childLoop.runLoop(
							childKey,
							c.state.workflowId,
							c.state.input,
							mergedStepResults,
							loopContext,
							`${c.state.loopKeyPrefix}iter${runtime.index}-${currentNodeId}-${currentNodeAlias}-`,
							c.name,
							c.state.selfKey,
							callbackName,
							token,
						);
						dispatched += 1;
						progressed = true;
						continue;
					}

					if (currentNode.type === "parallel") {
						const client = c.client() as Record<string, unknown>;
						const childHandle = getParallelActorHandle(
							client,
							currentNode.parallelCoordinatorActorRef,
						);
						if (!childHandle) {
							runtime.stepResults[currentNodeAlias] = toFailedStepResult();
							completeIteration(
								c,
								runtime,
								true,
								`Parallel coordinator ref "${currentNode.parallelCoordinatorActorRef}" not found in registry`,
							);
							progressed = true;
							continue;
						}

						const childKey = `${c.state.workflowId}-${c.state.loopKeyPrefix}iter${runtime.index}-${currentNodeId}-${currentNodeAlias}-parallel`;
						const callbackName = `${node.id}:${node.alias}:iter${runtime.index}:node${runtime.nodeIndex}:${currentNodeId}:${currentNodeAlias}:parallel:${token}`;
						const childParallel = childHandle.getOrCreate(childKey);

						if (currentNode.continueOn === "detached") {
							await childParallel.runParallel(
								childKey,
								c.state.workflowId,
								c.state.input,
								mergedStepResults,
								loopContext,
							);
							runtime.stepResults[currentNodeAlias] = {
								result: { detached: true, key: childKey },
								state: { detached: true },
								status: "completed",
							};
							runtime.nodeIndex += 1;
							c.state.inFlight[String(idx)] = runtime;
						} else {
							runtime.pendingType = "parallel";
							runtime.pendingCallbackName = callbackName;
							runtime.pendingNodeName = currentNodeAlias;
							c.state.inFlight[String(idx)] = runtime;
							c.state.activeChildParallels[callbackName] = {
								ref: currentNode.parallelCoordinatorActorRef,
								key: childKey,
							};

							await childParallel.runParallel(
								childKey,
								c.state.workflowId,
								c.state.input,
								mergedStepResults,
								loopContext,
								c.name,
								c.state.selfKey,
								callbackName,
								token,
							);
						}
						dispatched += 1;
						progressed = true;
						continue;
					}

					runtime.stepResults[currentNodeAlias] = toFailedStepResult();
					completeIteration(c, runtime, true, `Unsupported node type "${currentNode.type}"`);
					progressed = true;
				}

				while (
					dispatched < maxDispatchPerTick &&
					c.state.nextIndex < c.state.items.length &&
					Object.keys(c.state.inFlight).length < limit &&
					!c.state.hardFailure
				) {
					const idx = c.state.nextIndex;
					c.state.inFlight[String(idx)] = {
						index: idx,
						nodeIndex: 0,
						stepResults: {},
						pendingType: null,
						pendingCallbackName: null,
						pendingNodeName: null,
					};
					c.state.nextIndex += 1;
					dispatched += 1;
					progressed = true;
				}

				if (
					Object.keys(c.state.inFlight).length === 0 &&
					c.state.nextIndex >= c.state.items.length
				) {
					if (c.state.hardFailure) {
						await finalizeLoop(
							c,
							"failed",
							c.state.firstHardFailureError ?? `Loop "${node.alias}" had a failed iteration`,
						);
						return;
					}
					await finalizeLoop(c, "completed");
					return;
				}

				if (progressed) {
					await c.schedule.after(0, "_continue", token);
				}
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

				if (c.state.iteratorPending && c.state.iteratorCallbackName === stepName) {
					delete c.state.activeStepActors[stepName];
					c.state.iteratorPending = false;
					c.state.iteratorCallbackName = null;

					if (isHardStepStatus(status)) {
						await finalizeLoop(
							c,
							"failed",
							error ?? terminalError(status, "Iterator failed", "Iterator cancelled"),
						);
						return;
					}
					if (!Array.isArray(result)) {
						await finalizeLoop(
							c,
							"failed",
							`forEach "${node.alias}": iterator must return an array, got ${typeof result}`,
						);
						return;
					}

					c.state.items = [...result];
					await c.schedule.after(0, "_continue", c.state.executionToken);
					return;
				}

				for (const [idxKey, runtime] of Object.entries(c.state.inFlight)) {
					if (runtime.pendingType !== "step" || runtime.pendingCallbackName !== stepName) continue;

					delete c.state.activeStepActors[stepName];
					runtime.stepResults[runtime.pendingNodeName ?? "unknown"] = {
						result,
						state: stepState,
						status,
					};

					const hardFailed = isHardStepStatus(status, continueOnError);
					runtime.pendingType = null;
					runtime.pendingCallbackName = null;
					runtime.pendingNodeName = null;

					if (hardFailed) {
						completeIteration(
							c,
							runtime,
							true,
							error ?? terminalError(status, "Step failed", "Step cancelled"),
						);
					} else {
						runtime.nodeIndex += 1;
						c.state.inFlight[idxKey] = runtime;
					}

					await c.schedule.after(0, "_continue", c.state.executionToken);
					return;
				}
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

				for (const [idxKey, runtime] of Object.entries(c.state.inFlight)) {
					if (runtime.pendingType !== "loop" || runtime.pendingCallbackName !== callbackName)
						continue;

					delete c.state.activeChildLoops[callbackName];
					runtime.stepResults[runtime.pendingNodeName ?? "unknown"] =
						loopResult ?? toFailedStepResult();

					const hardFailed = isHardChildStatus(status);
					runtime.pendingType = null;
					runtime.pendingCallbackName = null;
					runtime.pendingNodeName = null;

					if (hardFailed) {
						completeIteration(
							c,
							runtime,
							true,
							error ?? terminalError(status, "Nested loop failed", "Nested loop cancelled"),
						);
					} else {
						runtime.nodeIndex += 1;
						c.state.inFlight[idxKey] = runtime;
					}

					await c.schedule.after(0, "_continue", c.state.executionToken);
					return;
				}
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

				for (const [idxKey, runtime] of Object.entries(c.state.inFlight)) {
					if (runtime.pendingType !== "parallel" || runtime.pendingCallbackName !== callbackName)
						continue;

					delete c.state.activeChildParallels[callbackName];
					runtime.stepResults[runtime.pendingNodeName ?? "unknown"] =
						parallelResult ?? toFailedStepResult();

					const hardFailed = isHardChildStatus(status);
					runtime.pendingType = null;
					runtime.pendingCallbackName = null;
					runtime.pendingNodeName = null;

					if (hardFailed) {
						// Nested concurrent failed hard: this iteration terminates now.
						completeIteration(
							c,
							runtime,
							true,
							error ??
								terminalError(status, "Nested concurrent failed", "Nested concurrent cancelled"),
						);
					} else {
						// Nested concurrent finished: advance this iteration to its next body node.
						runtime.nodeIndex += 1;
						c.state.inFlight[idxKey] = runtime;
					}

					await c.schedule.after(0, "_continue", c.state.executionToken);
					return;
				}
			},

			cancel: async (c): Promise<void> => {
				if (c.state.status !== "running") return;

				c.state.status = "cancelled";
				c.state.completedAt = Date.now();
				c.state.executionToken = nextExecutionToken(c.state.executionToken);

				const activeSteps = Object.values(c.state.activeStepActors);
				const activeChildLoops = Object.values(c.state.activeChildLoops);
				const activeChildParallels = Object.values(c.state.activeChildParallels);

				c.state.iteratorPending = false;
				c.state.iteratorCallbackName = null;
				c.state.activeStepActors = {};
				c.state.activeChildLoops = {};
				c.state.activeChildParallels = {};

				const client = c.client() as Record<string, unknown>;
				await propagateStepCancel(client, activeSteps, getStepActorHandle, (_target, err) => {
					console.warn(
						`[${node.alias}/${c.state.workflowId}] Cancel propagation to step failed:`,
						err,
					);
				});
				await propagateLoopCancel(client, activeChildLoops, getLoopActorHandle, (_target, err) => {
					console.warn(
						`[${node.alias}/${c.state.workflowId}] Cancel propagation to loop failed:`,
						err,
					);
				});
				await propagateParallelCancel(
					client,
					activeChildParallels,
					getParallelActorHandle,
					(_target, err) => {
						console.warn(
							`[${node.alias}/${c.state.workflowId}] Cancel propagation to concurrent failed:`,
							err,
						);
					},
				);

				await finalizeLoop(c, "cancelled", "Loop cancelled");
			},

			getState: (c): LoopCoordinatorState & { duration: number | null } => ({
				status: c.state.status,
				selfKey: c.state.selfKey,
				workflowId: c.state.workflowId,
				input: c.state.input,
				mode: c.state.mode,
				concurrency: c.state.concurrency,
				loopKeyPrefix: c.state.loopKeyPrefix,
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
				loopResult: c.state.loopResult,
				iteratorPending: c.state.iteratorPending,
				iteratorCallbackName: c.state.iteratorCallbackName,
				items: c.state.items,
				nextIndex: c.state.nextIndex,
				completedCount: c.state.completedCount,
				iterations: c.state.iterations,
				inFlight: c.state.inFlight,
				hardFailure: c.state.hardFailure,
				firstHardFailureError: c.state.firstHardFailureError,
				activeStepActors: c.state.activeStepActors,
				activeChildLoops: c.state.activeChildLoops,
				activeChildParallels: c.state.activeChildParallels,
				duration:
					c.state.completedAt && c.state.startedAt ? c.state.completedAt - c.state.startedAt : null,
			}),
		},
	});
}
