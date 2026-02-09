/**
 * Error Types
 *
 * StepError allows steps to control error handling behavior.
 */

/**
 * Options for StepError.
 */
export interface StepErrorOptions {
	/** How the workflow should handle this error */
	behavior: "stop" | "continue" | "retry";
	/** Maximum retry attempts (for behavior: 'retry') */
	maxAttempts?: number;
	/** Backoff strategy (for behavior: 'retry') */
	backoff?: "linear" | "exponential";
}

/**
 * Custom error class for controlling step error behavior.
 *
 * @example
 * ```typescript
 * function myStep({ log }) {
 *   try {
 *     // ... do something
 *   } catch (e) {
 *     if (e.code === 'TIMEOUT') {
 *       throw new StepError('Database timeout', {
 *         behavior: 'retry',
 *         maxAttempts: 3,
 *         backoff: 'exponential'
 *       });
 *     }
 *     throw new StepError('Fatal error', { behavior: 'stop' });
 *   }
 * }
 * ```
 */
export class StepError extends Error {
	/** How the workflow should handle this error */
	readonly behavior: "stop" | "continue" | "retry";
	/** Maximum retry attempts (for behavior: 'retry') */
	readonly maxAttempts?: number;
	/** Backoff strategy (for behavior: 'retry') */
	readonly backoff?: "linear" | "exponential";

	constructor(message: string, options: StepErrorOptions) {
		super(message);
		this.name = "StepError";
		this.behavior = options.behavior;
		this.maxAttempts = options.maxAttempts;
		this.backoff = options.backoff;

		// Maintain proper stack trace in V8 environments
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, StepError);
		}
	}
}
