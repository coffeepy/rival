/**
 * Workflow Types
 *
 * Types for workflow definitions, metadata, and compiled workflows.
 */

import type { ZodSchema } from "zod";
import type { PlanNode } from "./plan";
import type { ErrorHandler, ForEachDefinition, StepDefinition } from "./step";

/**
 * A workflow definition before compilation.
 * Created by the builder API or file-based API.
 */
export interface WorkflowDefinition {
	/** Workflow name (unique identifier) */
	name: string;
	/** Step and forEach definitions in execution order */
	steps: (StepDefinition | ForEachDefinition)[];
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
	/** Actor definitions keyed by actor name */
	actors: Record<string, unknown>;
	/** Name of the coordinator actor name */
	coordinatorActorRef: string;
	/** Optional description */
	description?: string;
}
