/**
 * Context Types
 *
 * The context object passed to step functions.
 */

import type { StepResult, StepState } from "./step";

/**
 * Logger interface provided to steps.
 */
export interface StepLogger {
	debug(msg: string): void;
	debug(obj: object, msg?: string): void;
	info(msg: string): void;
	info(obj: object, msg?: string): void;
	warn(msg: string): void;
	warn(obj: object, msg?: string): void;
	error(msg: string): void;
	error(obj: object, msg?: string): void;
}

/**
 * Information about the previous step in the workflow.
 */
export interface LastStepInfo {
	/** Result from the previous step (undefined for first step) */
	result: unknown;
	/** State from the previous step ({} for first step) */
	state: StepState;
	/** Alias key of the previous step (null for first step) */
	alias: string | null;
}

/**
 * Loop context provided to steps executing inside a forEach loop.
 */
export interface LoopContext {
	/** The current item being processed */
	item: unknown;
	/** The index of the current item (0-based) */
	index: number;
	/** The full items array (readonly to prevent mutation) */
	items: readonly unknown[];
}

/**
 * The context object passed to every step function.
 *
 * @template TInput - The type of the workflow input
 */
export interface StepContext<TInput = unknown> {
	/** The validated workflow input */
	input: TInput;

	/** Mutable state for this step (set description, skipped, custom data) */
	state: StepState;

	/** Access to all executed steps' results and state */
	steps: Record<string, StepResult>;

	/** Shorthand for the immediately preceding step */
	lastStep: LastStepInfo;

	/** Structured logger (Pino-based) */
	log: StepLogger;

	/** Loop context when executing inside a forEach loop */
	loop?: LoopContext;
}

/**
 * Log entry stored in actor state.
 */
export interface LogEntry {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	timestamp: number;
	metadata?: Record<string, unknown>;
}
