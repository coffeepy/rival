/**
 * Workflow Types
 *
 * Types for workflow definitions, metadata, and compiled workflows.
 */

import type { ZodSchema } from "zod";
import type { PlanNode } from "./plan";
import type { ErrorHandler, StepDefinition } from "./step";

/**
 * A workflow definition before compilation.
 * Created by the builder API or file-based API.
 */
export interface WorkflowDefinition {
	/** Workflow name (unique identifier) */
	name: string;
	/** Step definitions in execution order */
	steps: StepDefinition[];
	/** Optional Zod schema for input validation */
	inputSchema?: ZodSchema;
	/** Optional workflow-level error handler */
	onError?: ErrorHandler;
	/** Optional description */
	description?: string;
}

/**
 * A compiled workflow ready for registration.
 * Contains actor definitions and the serializable plan.
 */
export interface CompiledWorkflow {
	/** Workflow name */
	name: string;
	/** Zod schema for input validation (if defined) */
	inputSchema?: ZodSchema;
	/** Serializable plan (AST) for execution and UI */
	plan: PlanNode[];
	/** Actor definitions keyed by actor type name */
	actors: Record<string, unknown>;
	/** Name of the coordinator actor type */
	coordinatorActorName: string;
	/** Optional description */
	description?: string;
}

/**
 * Workflow metadata returned by registry.list().
 * Lightweight info for UI display.
 */
export interface WorkflowMetadata {
	name: string;
	description?: string;
	stepCount: number;
	/** JSON Schema representation of input (for form generation) */
	inputJsonSchema?: object;
}

/**
 * Information about an active workflow run.
 */
export interface WorkflowRunInfo {
	runId: string;
	workflowName: string;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
	completedAt?: number;
}
