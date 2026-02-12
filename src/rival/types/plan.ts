/**
 * Plan Types
 *
 * The Plan (AST) drives both execution and UI rendering.
 * References actor refs (strings), not functions.
 */

import { z } from "zod";
import type { StepConfig } from "./step";

/**
 * A step node in the plan.
 */
export interface StepPlanNode {
	type: "step";
	/** Human-readable step name */
	name: string;
	/** Actor ref (used with client[actorRef].getOrCreate) */
	actorRef: string;
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
	/** Actor ref for condition evaluation */
	conditionActorRef: string;
	/** Nodes to execute if condition is true */
	then: PlanNode[];
	/** Nodes to execute if condition is false */
	else: PlanNode[];
}

/**
 * A loop node in the plan (forEach).
 * Iterates over a collection, executing do-nodes for each item.
 */
export interface LoopPlanNode {
	type: "loop";
	name: string;
	/** Actor ref for the iterator function (returns an array) */
	iteratorActorRef: string;
	/** Actor ref for the loop coordinator actor */
	loopCoordinatorActorRef: string;
	/** Nodes to execute each iteration */
	do: PlanNode[];
	/** Run iterations in parallel (fan-out/fan-in) */
	parallel?: boolean;
	/** Max in-flight iterations when parallel is true */
	concurrency?: number;
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
	/** Actor ref for the nested workflow coordinator */
	coordinatorActorRef: string;
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

// =============================================================================
// Zod Schemas — validate plan structure and enforce unique step names
// =============================================================================

export const stepPlanNodeSchema = z.object({
	type: z.literal("step"),
	name: z.string().min(1),
	actorRef: z.string().min(1),
	config: z.any().optional(),
});

const planNodeSchema = z.discriminatedUnion("type", [
	stepPlanNodeSchema,
	z.object({
		type: z.literal("branch"),
		name: z.string().min(1),
		conditionActorRef: z.string().min(1),
		// biome-ignore lint/suspicious/noThenProperty: "then" is the correct name for if/then/else branch nodes
		then: z.array(z.any()),
		else: z.array(z.any()),
	}),
	z.object({
		type: z.literal("loop"),
		name: z.string().min(1),
		iteratorActorRef: z.string().min(1),
		loopCoordinatorActorRef: z.string().min(1),
		do: z.array(z.any()),
		parallel: z.boolean().optional(),
		concurrency: z.number().int().min(1).optional(),
	}),
	z.object({
		type: z.literal("parallel"),
		name: z.string().min(1),
		children: z.array(z.any()),
	}),
	z.object({
		type: z.literal("workflow"),
		name: z.string().min(1),
		coordinatorActorRef: z.string().min(1),
	}),
]);

/**
 * Zod schema for a plan (array of PlanNodes) with unique step name enforcement.
 *
 * Use `planSchema.parse(plan)` to validate structure AND catch duplicate names.
 */
export const planSchema = z.array(planNodeSchema).superRefine((nodes, ctx) => {
	const seen = new Set<string>();
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (node.type === "step" || node.type === "loop") {
			if (seen.has(node.name)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Duplicate step name "${node.name}". Step and loop names must be unique.`,
					path: [i, "name"],
				});
			}
			seen.add(node.name);
		}
	}
});
