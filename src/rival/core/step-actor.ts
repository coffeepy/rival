/**
 * Step Actor Factory
 *
 * The heart of Rival - transforms a step function into a Rivet actor
 * with the function baked in at registration time.
 */

import { actor } from "rivetkit";
import { createStepLogger } from "../logging/logger";
import type { LogEntry, StepConfig, StepContext, StepFunction, StepState } from "../types";
import { StepError } from "../types";

/**
 * Step actor state.
 */
export interface StepActorState {
	status: "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";
	result: unknown;
	error: string | null;
	attempts: number;
	stepState: StepState;
	logs: LogEntry[];
	startedAt: number | null;
	completedAt: number | null;
}

/**
 * Result returned from step execution.
 */
export interface StepExecutionResult {
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
) {
	return actor({
		state: {
			status: "pending" as StepActorState["status"],
			result: null as unknown,
			error: null as string | null,
			attempts: 0,
			stepState: {} as StepState,
			logs: [] as LogEntry[],
			startedAt: null as number | null,
			completedAt: null as number | null,
		},

		actions: {
			/**
			 * Execute the step function with retry logic.
			 */
			execute: async (
				c,
				context: ExecuteContext,
				config?: StepConfig,
				workflowId?: string,
				stepName?: string,
			): Promise<StepExecutionResult> => {
				const maxAttempts = config?.maxAttempts ?? 1;
				const wfId = workflowId ?? "unknown";
				const name = stepName ?? "unknown";

				// Create logger that stores logs in actor state
				const log = createStepLogger({ workflowId: wfId, stepName: name }, c.state.logs, true);

				// Create mutable step state
				const stepState: StepState = {};

				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					c.state.attempts = attempt;
					c.state.status = "running";
					c.state.startedAt = c.state.startedAt ?? Date.now();

					try {
						log.info(`Executing (attempt ${attempt}/${maxAttempts})`);

						// Build full context with log and state
						const fullContext: StepContext<TInput> = {
							...(context as Omit<StepContext<TInput>, "log" | "state">),
							log,
							state: stepState,
						};

						// Execute the baked-in function
						const result = await stepFn(fullContext);

						// Check if step was skipped
						if (stepState.skipped) {
							c.state.status = "skipped";
							c.state.stepState = stepState;
							c.state.completedAt = Date.now();
							log.info("Step skipped");
							return { status: "skipped", stepState };
						}

						// Success
						c.state.status = "completed";
						c.state.result = result;
						c.state.stepState = stepState;
						c.state.completedAt = Date.now();
						log.info("Completed successfully");

						return { status: "completed", result, stepState };
					} catch (err) {
						const error = err instanceof Error ? err : new Error(String(err));
						const errorMsg = error.message;

						log.error(`Failed: ${errorMsg}`);

						// Handle StepError specially
						if (err instanceof StepError) {
							if (err.behavior === "continue") {
								// Log and continue - step is marked as failed but workflow continues
								c.state.status = "failed";
								c.state.error = errorMsg;
								c.state.stepState = stepState;
								c.state.completedAt = Date.now();
								return { status: "failed", error: errorMsg, stepState, continueOnError: true };
							}

							if (err.behavior === "retry") {
								const retryMax = err.maxAttempts ?? maxAttempts;
								if (attempt < retryMax) {
									const delay = calculateBackoff(attempt, err.backoff ?? config?.backoff);
									log.info(`Retrying in ${delay}ms...`);
									await sleep(delay);
									continue;
								}
							}

							// behavior === 'stop' or exhausted retries
							c.state.status = "failed";
							c.state.error = errorMsg;
							c.state.stepState = stepState;
							c.state.completedAt = Date.now();
							return { status: "failed", error: errorMsg, stepState };
						}

						// Regular error - check if we should retry based on config
						if (attempt < maxAttempts) {
							const delay = calculateBackoff(attempt, config?.backoff);
							log.info(`Retrying in ${delay}ms...`);
							await sleep(delay);
							continue;
						}

						// Exhausted retries
						c.state.status = "failed";
						c.state.error = errorMsg;
						c.state.stepState = stepState;
						c.state.completedAt = Date.now();
						return { status: "failed", error: errorMsg, stepState };
					}
				}

				// Should never reach here
				c.state.status = "failed";
				c.state.error = "Unknown error";
				c.state.completedAt = Date.now();
				return { status: "failed", error: "Unknown error", stepState };
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
				logs: c.state.logs,
				startedAt: c.state.startedAt,
				completedAt: c.state.completedAt,
				duration:
					c.state.completedAt && c.state.startedAt ? c.state.completedAt - c.state.startedAt : null,
			}),

			/**
			 * Cancel the step (marks as cancelled, cannot stop in-flight work).
			 */
			cancel: (c) => {
				if (c.state.status === "running" || c.state.status === "pending") {
					c.state.status = "cancelled";
					c.state.completedAt = Date.now();
				}
			},
		},
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

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
