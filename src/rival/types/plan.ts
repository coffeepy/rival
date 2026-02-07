/**
 * Plan Types
 *
 * The Plan (AST) drives both execution and UI rendering.
 * References actor type names (strings), not functions.
 */

import type { StepConfig } from "./step";

/**
 * A step node in the plan.
 */
export interface StepPlanNode {
	type: "step";
	/** Human-readable step name */
	name: string;
	/** Actor type name (used with client[actorType].getOrCreate) */
	actorType: string;
	/** Step configuration (timeout, retry, etc.) */
	config?: StepConfig;
}

/**
 * A branch node (if/then/else) in the plan.
 * Future phase - not implemented in Phase 1.
 */
export interface BranchPlanNode {
	type: "branch";
	name: string;
	/** Actor type for condition evaluation */
	conditionActorType: string;
	/** Nodes to execute if condition is true */
	then: PlanNode[];
	/** Nodes to execute if condition is false */
	else: PlanNode[];
}

/**
 * A loop node in the plan.
 * Future phase - not implemented in Phase 1.
 */
export interface LoopPlanNode {
	type: "loop";
	name: string;
	/** Actor type for condition evaluation */
	conditionActorType: string;
	/** Nodes to execute each iteration */
	body: PlanNode[];
}

/**
 * A parallel execution node in the plan.
 * Future phase - not implemented in Phase 1.
 */
export interface ParallelPlanNode {
	type: "parallel";
	name: string;
	/** Nodes to execute concurrently */
	children: PlanNode[];
}

/**
 * A nested workflow node in the plan.
 * Future phase - not implemented in Phase 1.
 */
export interface WorkflowPlanNode {
	type: "workflow";
	name: string;
	/** Actor type for the nested workflow coordinator */
	coordinatorActorType: string;
}

/**
 * Union of all plan node types.
 * The plan is serializable (no functions) so it can be sent to UI.
 */
export type PlanNode =
	| StepPlanNode
	| BranchPlanNode
	| LoopPlanNode
	| ParallelPlanNode
	| WorkflowPlanNode;
