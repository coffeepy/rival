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
	/** Internal unique node ID used for runtime correlation */
	id: string;
	/** User-facing key used in context.steps and workflow results */
	alias: string;
	/** Optional display label for logs/UI */
	name?: string;
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
	/** Internal unique node ID used for runtime correlation */
	id: string;
	/** User-facing key used in context.steps and workflow results */
	alias: string;
	/** Optional display label for logs/UI */
	name?: string;
	/** Actor ref for condition evaluation */
	conditionActorRef: string;
	/** Nodes to execute if condition is true */
	then: PlanNode[];
	/** Nodes to execute if condition is false */
	else: PlanNode[];
}

/**
 * A loop node in the plan (forEach).
 * Iterates over a collection, executing run-nodes for each item.
 */
export interface LoopPlanNode {
	type: "loop";
	/** Internal unique node ID used for runtime correlation */
	id: string;
	/** User-facing key used in context.steps and workflow results */
	alias: string;
	/** Optional display label for logs/UI */
	name?: string;
	/** Actor ref for the iterator function (returns an array) */
	iteratorActorRef: string;
	/** Actor ref for the loop coordinator actor */
	loopCoordinatorActorRef: string;
	/** Nodes to execute each iteration */
	run: PlanNode[];
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
	id: string;
	alias: string;
	name?: string;
	/** Nodes to execute concurrently */
	children: PlanNode[];
}

/**
 * A nested workflow node in the plan.
 * Future phase - not implemented in Phase 1.
 */
export interface WorkflowPlanNode {
	type: "workflow";
	id: string;
	alias: string;
	name?: string;
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
	id: z.string().min(1),
	alias: z.string().min(1),
	name: z.string().min(1).optional(),
	actorRef: z.string().min(1),
	config: z.any().optional(),
});

const planNodeSchema = z.discriminatedUnion("type", [
	stepPlanNodeSchema,
	z.object({
		type: z.literal("branch"),
		id: z.string().min(1),
		alias: z.string().min(1),
		name: z.string().min(1).optional(),
		conditionActorRef: z.string().min(1),
		// biome-ignore lint/suspicious/noThenProperty: "then" is the correct name for if/then/else branch nodes
		then: z.array(z.any()),
		else: z.array(z.any()),
	}),
	z.object({
		type: z.literal("loop"),
		id: z.string().min(1),
		alias: z.string().min(1),
		name: z.string().min(1).optional(),
		iteratorActorRef: z.string().min(1),
		loopCoordinatorActorRef: z.string().min(1),
		run: z.array(z.any()),
		parallel: z.boolean().optional(),
		concurrency: z.number().int().min(1).optional(),
	}),
	z.object({
		type: z.literal("parallel"),
		id: z.string().min(1),
		alias: z.string().min(1),
		name: z.string().min(1).optional(),
		children: z.array(z.any()),
	}),
	z.object({
		type: z.literal("workflow"),
		id: z.string().min(1),
		alias: z.string().min(1),
		name: z.string().min(1).optional(),
		coordinatorActorRef: z.string().min(1),
	}),
]);

/**
 * Zod schema for a plan (array of PlanNodes) with unique id+alias enforcement.
 *
 * Use `planSchema.parse(plan)` to validate structure AND catch duplicate names.
 */
export const planSchema = z.array(planNodeSchema).superRefine((nodes, ctx) => {
	const seenIds = new Set<string>();
	const seenAliases = new Set<string>();
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (node.type === "step" || node.type === "loop" || node.type === "branch") {
			if (seenIds.has(node.id)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Duplicate node id "${node.id}". Step, loop, and branch ids must be unique.`,
					path: [i, "id"],
				});
			}
			seenIds.add(node.id);

			if (seenAliases.has(node.alias)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Duplicate alias "${node.alias}". Step, loop, and branch aliases must be unique.`,
					path: [i, "alias"],
				});
			}
			seenAliases.add(node.alias);
		}
	}
});
