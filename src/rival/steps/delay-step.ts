/**
 * Delay Step Factory
 *
 * Creates a step function that waits for a specified duration.
 *
 * @example
 * ```typescript
 * // Fixed delay
 * const wait5Seconds = delayStep({ seconds: 5 });
 *
 * // Dynamic delay based on input
 * const dynamicWait = delayStep({
 *   seconds: ({ input }) => input.waitTime,
 * });
 *
 * // With milliseconds
 * const shortWait = delayStep({ milliseconds: 500 });
 * ```
 */

import type { StepContext, StepFunction } from "../types";

/**
 * Delay step configuration.
 */
export interface DelayStepConfig {
	/** Delay in seconds (takes precedence over milliseconds) */
	seconds?: number | ((context: StepContext) => number);
	/** Delay in milliseconds */
	milliseconds?: number | ((context: StepContext) => number);
}

/**
 * Delay step result.
 */
export interface DelayStepResult {
	/** Actual delay in milliseconds */
	delayedMs: number;
	/** Timestamp when delay started */
	startedAt: number;
	/** Timestamp when delay ended */
	endedAt: number;
}

/**
 * Creates a step function that delays execution.
 *
 * @param config - Delay configuration
 * @returns A step function that waits for the specified duration
 */
export function delayStep(config: DelayStepConfig): StepFunction<unknown, DelayStepResult> {
	const { seconds, milliseconds } = config;

	if (seconds === undefined && milliseconds === undefined) {
		throw new Error("delayStep requires either 'seconds' or 'milliseconds'");
	}

	return async function delay(context: StepContext): Promise<DelayStepResult> {
		const { log, state } = context;

		// Calculate delay in milliseconds
		let delayMs: number;
		if (seconds !== undefined) {
			const resolvedSeconds = typeof seconds === "function" ? seconds(context) : seconds;
			delayMs = resolvedSeconds * 1000;
		} else {
			delayMs = typeof milliseconds === "function" ? milliseconds(context) : (milliseconds ?? 0);
		}

		const startedAt = Date.now();

		if (delayMs <= 0) {
			log.info("No delay needed (duration <= 0)");
			state.description = "No delay (skipped)";
			return {
				delayedMs: 0,
				startedAt,
				endedAt: startedAt,
			};
		}

		const displayTime = delayMs >= 1000 ? `${(delayMs / 1000).toFixed(1)}s` : `${delayMs}ms`;

		log.info(`Delaying for ${displayTime}`);
		state.description = `Waiting ${displayTime}`;

		await new Promise((resolve) => setTimeout(resolve, delayMs));

		const endedAt = Date.now();
		const actualDelay = endedAt - startedAt;

		log.info(`Delay completed (actual: ${actualDelay}ms)`);
		state.description = `Delayed ${displayTime}`;

		return {
			delayedMs: actualDelay,
			startedAt,
			endedAt,
		};
	};
}
