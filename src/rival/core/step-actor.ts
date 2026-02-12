/**
 * Step Actor Factory
 *
 * The heart of Rival - transforms a step function into a Rivet actor
 * with the function baked in at registration time.
 */

import { actor } from "rivetkit";
import { createStepLogger } from "../logging/logger";
import type {
	LogEntry,
	StepActorConfig,
	StepConfig,
	StepContext,
	StepFunction,
	StepState,
} from "../types";
import { StepError } from "../types";

/**
 * Step actor state.
 */
export interface StepActorState {
	status:
		| "pending"
		| "running"
		| "waiting_retry"
		| "completed"
		| "failed"
		| "skipped"
		| "cancelled";
	result: unknown;
	error: string | null;
	attempts: number;
	stepState: StepState;
	continueOnError: boolean;
	logs: LogEntry[];
	startedAt: number | null;
	completedAt: number | null;
	context: ExecuteContext | null;
	config: StepConfig | null;
	workflowId: string | null;
	activeStepName: string | null;
	coordinatorRef: string | null;
	coordinatorKey: string | null;
	executionToken: number;
	timeoutToken: number | null;
}

/**
 * Result returned from step execution.
 */
export interface StepExecutionResult {
	status: "running" | "completed" | "failed" | "skipped";
	result?: unknown;
	error?: string;
	stepState: StepState;
	/** When true, a failed step should not stop the workflow */
	continueOnError?: boolean;
}

/**
 * Result returned from execute kickoff.
 */
export interface StepExecutionKickoffResult {
	status: "running";
	stepState: StepState;
}

/**
 * Result returned from terminal state lookup.
 */
export interface StepExecutionTerminalResult {
	status: "completed" | "failed" | "skipped";
	result?: unknown;
	error?: string;
	stepState: StepState;
	/** When true, a failed step should not stop the workflow */
	continueOnError?: boolean;
}

/**
 * Context passed to execute action (without log/state which are added internally).
 */
export type ExecuteContext = Omit<StepContext, "log" | "state">;

/**
 * Creates a step actor with the function baked in.
 *
 * This is the core transformation that makes Rival work with Rivet's
 * distribution model. The function is embedded in the actor definition
 * at registration time, not looked up at runtime.
 *
 * @param stepFn - The step function to embed in the actor
 * @returns A Rivet actor definition
 */
export function createStepActor<TInput = unknown, TResult = unknown>(
	stepFn: StepFunction<TInput, TResult>,
	actorConfig?: StepActorConfig,
) {
	function createLogger(c: { state: StepActorState }) {
		const workflowId = c.state.workflowId ?? "unknown";
		const stepName = c.state.activeStepName ?? "unknown";
		return createStepLogger({ workflowId, stepName }, c.state.logs, true);
	}

	async function notifyCoordinator(c: {
		state: StepActorState;
		client: () => Record<string, unknown>;
	}) {
		const coordinatorRef = c.state.coordinatorRef;
		const coordinatorKey = c.state.coordinatorKey;
		if (!coordinatorRef || !coordinatorKey) return;

		const coordinatorType = c.client()[coordinatorRef] as
			| {
					getOrCreate: (key: string) => { onStepFinished?: (...args: unknown[]) => Promise<void> };
			  }
			| undefined;
		const callback = coordinatorType?.getOrCreate(coordinatorKey).onStepFinished;
		if (!callback) return;

		await callback(
			c.state.activeStepName,
			c.state.status,
			c.state.result,
			c.state.error,
			c.state.stepState,
			c.state.continueOnError,
		);
	}

	function toTerminalResult(c: { state: StepActorState }): StepExecutionTerminalResult {
		const status = c.state.status === "cancelled" ? "failed" : c.state.status;
		return {
			status:
				status === "completed" || status === "failed" || status === "skipped" ? status : "failed",
			result: c.state.result,
			error: c.state.error ?? undefined,
			stepState: c.state.stepState,
			continueOnError: c.state.continueOnError || undefined,
		};
	}

	async function finalize(
		c: { state: StepActorState; client: () => Record<string, unknown> },
		next: {
			status: StepActorState["status"];
			result?: unknown;
			error?: string | null;
			continueOnError?: boolean;
		},
	) {
		c.state.status = next.status;
		c.state.result = next.result ?? null;
		c.state.error = next.error ?? null;
		c.state.continueOnError = next.continueOnError ?? false;
		c.state.completedAt = Date.now();
		c.state.timeoutToken = null;
		await notifyCoordinator(c);
	}

	async function invokeStepOnError(
		c: { state: StepActorState },
		error: Error,
		context: ExecuteContext,
		config: StepConfig,
	) {
		if (!config.onError) return;
		try {
			await config.onError({
				error,
				failedStep: {
					result: c.state.result,
					state: c.state.stepState,
					stepName: c.state.activeStepName ?? "unknown",
					status: c.state.status,
				},
				workflowState: {
					input: context.input,
					steps: context.steps ?? {},
					status: "failed",
					runId: c.state.workflowId ?? "unknown",
					workflowName: c.state.workflowId ?? "unknown",
				},
			});
		} catch {
			const log = createLogger(c);
			log.error("Step onError handler failed");
		}
	}

	return actor({
		state: {
			status: "pending" as StepActorState["status"],
			result: null as unknown,
			error: null as string | null,
			attempts: 0,
			stepState: {} as StepState,
			continueOnError: false,
			logs: [] as LogEntry[],
			startedAt: null as number | null,
			completedAt: null as number | null,
			context: null as ExecuteContext | null,
			config: null as StepConfig | null,
			workflowId: null as string | null,
			activeStepName: null as string | null,
			coordinatorRef: null as string | null,
			coordinatorKey: null as string | null,
			executionToken: 0,
			timeoutToken: null as number | null,
		},

		actions: {
			/**
			 * Kick off asynchronous execution.
			 */
			execute: async (
				c,
				context: ExecuteContext,
				config?: StepConfig,
				workflowId?: string,
				stepName?: string,
				coordinatorRef?: string,
				coordinatorKey?: string,
			): Promise<StepExecutionKickoffResult> => {
				const token = Date.now() + Math.floor(Math.random() * 1000000);

				c.state.status = "running";
				c.state.result = null;
				c.state.error = null;
				c.state.attempts = 0;
				c.state.stepState = {};
				c.state.continueOnError = false;
				c.state.startedAt = Date.now();
				c.state.completedAt = null;
				c.state.context = context;
				c.state.config = config ?? {};
				c.state.workflowId = workflowId ?? "unknown";
				c.state.activeStepName = stepName ?? "unknown";
				c.state.coordinatorRef = coordinatorRef ?? null;
				c.state.coordinatorKey = coordinatorKey ?? null;
				c.state.executionToken = token;
				c.state.timeoutToken = null;

				const log = createLogger(c);
				log.info("Step scheduled for execution");

				if ((config?.timeout ?? 0) > 0) {
					c.state.timeoutToken = token;
					const timeoutMs = config?.timeout ?? 0;
					await c.schedule.after(timeoutMs, "_onTimeout", token);
				}

				await c.schedule.after(0, "_attempt", token);
				return { status: "running", stepState: c.state.stepState };
			},

			_attempt: async (c, token: number): Promise<void> => {
				if (c.state.executionToken !== token) return;
				if (
					c.state.status === "completed" ||
					c.state.status === "failed" ||
					c.state.status === "skipped" ||
					c.state.status === "cancelled"
				) {
					return;
				}

				const context = c.state.context;
				const config = c.state.config ?? {};
				if (!context) return;

				const log = createLogger(c);
				const maxAttempts = config.maxAttempts ?? 1;
				c.state.status = "running";
				c.state.attempts += 1;
				const attempt = c.state.attempts;

				try {
					log.info(`Executing (attempt ${attempt}/${maxAttempts})`);
					const fullContext: StepContext<TInput> = {
						...(context as Omit<StepContext<TInput>, "log" | "state">),
						log,
						state: c.state.stepState,
					};
					const result = await stepFn(fullContext);

					if (c.state.stepState.skipped) {
						log.info("Step skipped");
						await finalize(c, {
							status: "skipped",
						});
						return;
					}

					log.info("Completed successfully");
					await finalize(c, {
						status: "completed",
						result,
					});
					return;
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					const errorMsg = error.message;
					log.error(`Failed: ${errorMsg}`);

					if (err instanceof StepError && err.behavior === "continue") {
						await finalize(c, {
							status: "failed",
							error: errorMsg,
							continueOnError: true,
						});
						await invokeStepOnError(c, error, context, config);
						return;
					}

					const retryLimit =
						err instanceof StepError && err.behavior === "retry"
							? Math.min(err.maxAttempts ?? maxAttempts, maxAttempts)
							: maxAttempts;

					if (
						((err instanceof StepError && err.behavior === "retry") ||
							!(err instanceof StepError)) &&
						attempt < retryLimit
					) {
						const backoff =
							err instanceof StepError && err.behavior === "retry"
								? (err.backoff ?? config.backoff)
								: config.backoff;
						const delay = calculateBackoff(attempt, backoff);
						c.state.status = "waiting_retry";
						await c.saveState({ immediate: true });
						log.info(`Retrying in ${delay}ms...`);
						await c.schedule.after(delay, "_attempt", token);
						return;
					}

					await finalize(c, {
						status: "failed",
						error: errorMsg,
					});
					await invokeStepOnError(c, error, context, config);
				}
			},

			_onTimeout: async (c, token: number): Promise<void> => {
				if (c.state.timeoutToken !== token || c.state.executionToken !== token) return;
				if (
					c.state.status === "completed" ||
					c.state.status === "failed" ||
					c.state.status === "skipped" ||
					c.state.status === "cancelled"
				) {
					return;
				}

				const context = c.state.context;
				const config = c.state.config ?? {};
				if (!context) return;

				const log = createLogger(c);
				const timeoutMsg = `Step timed out after ${config.timeout ?? 0}ms`;
				log.error(timeoutMsg);

				if (config.onTimeout === "retry") {
					const maxAttempts = config.maxAttempts ?? 1;
					if (c.state.attempts < maxAttempts) {
						const delay = calculateBackoff(Math.max(c.state.attempts, 1), config.backoff);
						c.state.status = "waiting_retry";
						await c.saveState({ immediate: true });
						log.info(`Retrying after timeout in ${delay}ms...`);
						await c.schedule.after(delay, "_attempt", token);
						return;
					}
				}

				const error = new Error(timeoutMsg);
				await finalize(c, {
					status: "failed",
					error: timeoutMsg,
				});
				await invokeStepOnError(c, error, context, config);
			},

			getTerminalResult: (c): StepExecutionTerminalResult | null => {
				if (
					c.state.status !== "completed" &&
					c.state.status !== "failed" &&
					c.state.status !== "skipped" &&
					c.state.status !== "cancelled"
				) {
					return null;
				}
				return toTerminalResult(c);
			},

			/**
			 * Get the current state of the step actor.
			 */
			getState: (c): StepActorState & { duration: number | null } => ({
				status: c.state.status,
				result: c.state.result,
				error: c.state.error,
				attempts: c.state.attempts,
				stepState: c.state.stepState,
				continueOnError: c.state.continueOnError,
				logs: c.state.logs,
				startedAt: c.state.startedAt,
				completedAt: c.state.completedAt,
				context: c.state.context,
				config: c.state.config,
				workflowId: c.state.workflowId,
				activeStepName: c.state.activeStepName,
				coordinatorRef: c.state.coordinatorRef,
				coordinatorKey: c.state.coordinatorKey,
				executionToken: c.state.executionToken,
				timeoutToken: c.state.timeoutToken,
				duration:
					c.state.completedAt && c.state.startedAt ? c.state.completedAt - c.state.startedAt : null,
			}),

			/**
			 * Cancel the step (marks as cancelled, cannot stop in-flight work).
			 */
			cancel: (c) => {
				if (
					c.state.status === "running" ||
					c.state.status === "pending" ||
					c.state.status === "waiting_retry"
				) {
					c.state.status = "cancelled";
					c.state.completedAt = Date.now();
					c.state.executionToken += 1;
					c.state.timeoutToken = null;
				}
			},
		},
		options:
			actorConfig?.options !== undefined
				? (actorConfig.options as Parameters<typeof actor>[0]["options"])
				: undefined,
	});
}

/**
 * Calculate backoff delay in milliseconds.
 */
function calculateBackoff(attempt: number, strategy?: "linear" | "exponential"): number {
	const baseDelay = 100; // 100ms base

	if (strategy === "exponential") {
		return baseDelay * 2 ** (attempt - 1); // 100, 200, 400, 800...
	}

	// Linear (default)
	return baseDelay * attempt; // 100, 200, 300, 400...
}
