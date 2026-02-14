/**
 * Step Types
 *
 * Types for step functions, configuration, and results.
 */

import type { StepContext } from "./context";
import type { WorkflowDefinition } from "./workflow";

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
export interface StepActorOptions {
	/** Rivet hard action timeout in milliseconds */
	actionTimeout?: number;
	[key: string]: unknown;
}

export interface StepActorConfig {
	options?: StepActorOptions;
}

export interface StepConfig {
	/** Timeout in milliseconds */
	timeout?: number;
	/** Escape hatch for underlying Rivet actor options */
	actor?: StepActorConfig;
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
	failedStep: { result: unknown; state: StepState; alias: string; status: string };
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
	/** Internal unique node ID used for runtime correlation */
	id: string;
	/** User-facing key used in context.steps and workflow results */
	alias: string;
	/** Optional display label for logs/UI */
	name?: string;
	run: StepFunction;
	config?: StepConfig;
}

/**
 * ForEach loop definition.
 *
 * `run` accepts either a StepFunction (single step body) or a WorkflowDefinition
 * (multi-step body). The compiler detects which one and compiles accordingly.
 */
export interface ForEachDefinition {
	type: "forEach";
	/** Internal unique node ID used for runtime correlation */
	id: string;
	/** User-facing key used in context.steps and workflow results */
	alias: string;
	/** Optional display label for logs/UI */
	name?: string;
	/** Step function that returns the items array to iterate over */
	items: StepFunction;
	/** Body: a single step function or a full workflow definition */
	run: StepFunction | WorkflowDefinition;
	/** Run iterations in parallel (fan-out/fan-in) */
	parallel?: boolean;
	/** Max in-flight iterations when running in parallel mode */
	concurrency?: number;
}

/**
 * Concurrent definition.
 *
 * `steps` accepts step functions or object entries with `run`, and each run
 * can be either a StepFunction or a nested WorkflowDefinition.
 */
export interface ConcurrentStepDefinition {
	/** Internal unique node ID used for runtime correlation */
	id: string;
	/** User-facing key used in concurrent result maps */
	alias: string;
	/** Optional display label for logs/UI */
	name?: string;
	/** Step body: single function or nested workflow */
	run: StepFunction | WorkflowDefinition;
	/** Optional step configuration (applies to function runs) */
	config?: StepConfig;
}

export interface ConcurrentDefinition {
	type: "concurrent";
	/** Internal unique node ID used for runtime correlation */
	id: string;
	/** User-facing key used in context.steps and workflow results */
	alias: string;
	/** Optional display label for logs/UI */
	name?: string;
	/** Steps to run concurrently */
	steps: ConcurrentStepDefinition[];
	/** Continue policy for advancing parent execution. */
	continueOn?: "all" | "detached";
	/** Failure aggregation mode for child hard failures. */
	onFailure?: "fail" | "collect";
}
