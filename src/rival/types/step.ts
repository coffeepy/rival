/**
 * Step Types
 *
 * Types for step functions, configuration, and results.
 */

import type { StepContext } from "./context";

/**
 * A step function that can be executed by the workflow engine.
 * Receives context and returns a result (or Promise of result).
 */
export type StepFunction<TInput = unknown, TResult = unknown> = (
	context: StepContext<TInput>,
) => TResult | Promise<TResult>;

/**
 * Configuration options for a step.
 */
export interface StepConfig {
	/** Timeout in milliseconds */
	timeout?: number;
	/** Maximum number of execution attempts */
	maxAttempts?: number;
	/** What to do when timeout occurs */
	onTimeout?: "stop" | "retry";
	/** Backoff strategy for retries */
	backoff?: "linear" | "exponential";
	/** Custom error handler for this step */
	onError?: ErrorHandler;
}

/**
 * Error handler function signature.
 */
export type ErrorHandler = (context: {
	error: Error;
	failedStep: { result: unknown; state: StepState; stepName: string; status: string };
	workflowState: {
		input: unknown;
		steps: Record<string, StepResult>;
		status: string;
		runId: string;
		workflowName: string;
	};
}) => void | Promise<void>;

/**
 * Mutable state that steps can write to.
 */
export interface StepState {
	/** Human-readable description of what the step did */
	description?: string;
	/** Set to true to mark step as skipped */
	skipped?: boolean;
	/** Additional step-specific state */
	[key: string]: unknown;
}

/**
 * Result of a completed step.
 */
export interface StepResult {
	result: unknown;
	state: StepState;
	status: "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";
}

/**
 * Metrics tracked for each step execution.
 */
export interface StepMetrics {
	status: "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";
	startedAt?: number;
	completedAt?: number;
	duration?: number;
	retryCount: number;
	error?: {
		message: string;
		stack?: string;
		attemptNumber: number;
		occurredAt: number;
	};
}

/**
 * Step definition used internally.
 */
export interface StepDefinition {
	fn: StepFunction;
	name: string;
	config?: StepConfig;
}
