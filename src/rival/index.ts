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
 *   { type: 'step', name: 'findTree', actorType: 'findTreeStep' },
 *   { type: 'step', name: 'chopTree', actorType: 'chopTreeStep' },
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
	// Step types
	StepFunction,
	StepConfig,
	StepState,
	StepResult,
	StepMetrics,
	StepDefinition,
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
	WorkflowMetadata,
	WorkflowRunInfo,
	// Error types
	StepErrorOptions,
} from "./types";

// Error class
export { StepError } from "./types";

// Builder API
export { createWorkflow, WorkflowBuilder } from "./builder/workflow-builder";
export type { StepInput } from "./builder/workflow-builder";

// Compiler
export { compileWorkflow, defineWorkflow } from "./builder/compiler";

// Registry
export {
	WorkflowRegistry,
	workflowRegistry,
	createRegistryActor,
	registerWorkflow,
} from "./core/registry-actor";
export type { ActiveRun, RegistryActorState, LaunchResult } from "./core/registry-actor";

// Predefined Steps
export { httpStep, delayStep } from "./steps";
export type {
	HttpStepConfig,
	HttpStepResult,
	DelayStepConfig,
	DelayStepResult,
} from "./steps";
