/**
 * Rival - Workflow Engine Library
 *
 * Built on RivetKit. Developer-first. Single executable deployment.
 *
 * @example
 * ```typescript
 * import { createStepActor, createWorkflowCoordinator, StepError } from './src/rival';
 *
 * // Define step functions
 * function findTree({ input, log }) {
 *   log.info('Finding tree...');
 *   return { treeId: 'oak-123' };
 * }
 *
 * // Create step actors (functions baked in)
 * const findTreeStep = createStepActor(findTree);
 * const chopTreeStep = createStepActor(chopTree);
 *
 * // Create plan
 * const plan = [
 *   { type: 'step', name: 'findTree', actorRef: 'findTreeStep' },
 *   { type: 'step', name: 'chopTree', actorRef: 'chopTreeStep' },
 * ];
 *
 * // Create coordinator
 * const coordinator = createWorkflowCoordinator('treeWorkflow', plan);
 *
 * // Register with Rivet
 * const registry = setup({
 *   use: { findTreeStep, chopTreeStep, treeWorkflow: coordinator }
 * });
 * ```
 */

// Core actor factories
export { createStepActor } from "./core/step-actor";
export type { StepActorState, StepExecutionResult, ExecuteContext } from "./core/step-actor";

export { createWorkflowCoordinator } from "./core/workflow-coordinator";
export type {
	WorkflowCoordinatorState,
	WorkflowExecutionResult,
} from "./core/workflow-coordinator";

// Context utilities
export { buildStepContext, createEmptyStepState } from "./core/context-builder";
export type { WorkflowState } from "./core/context-builder";

// Logging
export { createStepLogger } from "./logging/logger";
export type { LoggerContext } from "./logging/logger";

// Types
export type {
	// Context types
	StepContext,
	StepLogger,
	LastStepInfo,
	LogEntry,
	LoopContext,
	// Step types
	StepFunction,
	StepActorConfig,
	StepActorOptions,
	StepConfig,
	StepState,
	StepResult,
	StepMetrics,
	StepDefinition,
	ForEachDefinition,
	ErrorHandler,
	// Plan types
	PlanNode,
	StepPlanNode,
	BranchPlanNode,
	LoopPlanNode,
	ParallelPlanNode,
	WorkflowPlanNode,
	// Workflow types
	WorkflowDefinition,
	CompiledWorkflow,
	// Error types
	StepErrorOptions,
} from "./types";

// Error class
export { StepError } from "./types";

// Plan schemas
export { planSchema, stepPlanNodeSchema } from "./types";

// Builder API
export { createWorkflow, WorkflowBuilder } from "./builder/workflow-builder";
export type { StepInput, ForEachInput } from "./builder/workflow-builder";

// Compiler
export { compileWorkflow, defineWorkflow } from "./builder/compiler";

// Engine (top-level convenience API)
export { rival, RivalEngine } from "./engine";
export type {
	CoordinatorHandle,
	CoordinatorInstance,
	WaitOptions,
	WorkflowRunStartResult,
} from "./engine";

// Predefined Steps
export { httpStep, delayStep } from "./steps";
export type {
	HttpStepConfig,
	HttpStepResult,
	DelayStepConfig,
	DelayStepResult,
} from "./steps";
