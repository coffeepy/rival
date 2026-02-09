/**
 * Workflow Compiler
 *
 * Transforms a WorkflowDefinition into a CompiledWorkflow.
 * Creates actor definitions with step functions baked in.
 *
 * @example
 * ```typescript
 * const definition = createWorkflow('tree')
 *   .step(findTree)
 *   .step(chopTree)
 *   .build();
 *
 * const compiled = compileWorkflow(definition);
 * // compiled.actors = { tree_findTree, tree_chopTree, tree_coordinator }
 * // compiled.plan = [{ type: 'step', name: 'findTree', actorType: 'tree_findTree' }, ...]
 * ```
 */

import { createStepActor } from "../core/step-actor";
import { createWorkflowCoordinator } from "../core/workflow-coordinator";
import type { CompiledWorkflow, PlanNode, StepPlanNode, WorkflowDefinition } from "../types";

/**
 * Compile a workflow definition into actors and a plan.
 *
 * This is the key transformation that:
 * 1. Creates step actors with functions baked in
 * 2. Creates a coordinator actor
 * 3. Generates a serializable plan (AST)
 *
 * @param definition - The workflow definition to compile
 * @returns A compiled workflow ready for registration
 */
export function compileWorkflow(definition: WorkflowDefinition): CompiledWorkflow {
	const { name, steps, inputSchema, description } = definition;

	// Validate no duplicate step names
	const seen = new Set<string>();
	for (const step of steps) {
		if (seen.has(step.name)) {
			throw new Error(
				`Workflow "${name}" has duplicate step name "${step.name}". Step names must be unique.`,
			);
		}
		seen.add(step.name);
	}

	// Build actors and plan nodes
	const actors: Record<string, unknown> = {};
	const plan: PlanNode[] = [];

	for (const step of steps) {
		// Generate unique actor type name: {workflowName}_{stepName}
		const actorTypeName = `${name}_${step.name}`;

		// Create step actor with function BAKED IN
		actors[actorTypeName] = createStepActor(step.fn);

		// Add to plan (referencing actor by type name string)
		const planNode: StepPlanNode = {
			type: "step",
			name: step.name,
			actorType: actorTypeName,
			config: step.config,
		};
		plan.push(planNode);
	}

	// Create the coordinator actor
	const coordinatorActorName = `${name}_coordinator`;
	actors[coordinatorActorName] = createWorkflowCoordinator(name, plan, inputSchema);

	return {
		name,
		inputSchema,
		plan,
		actors,
		coordinatorActorName,
		description,
	};
}

/**
 * Convenience function to create and compile a workflow in one call.
 *
 * @param name - Workflow name
 * @param definition - Partial definition (steps, inputSchema, etc.)
 * @returns Compiled workflow
 *
 * @example
 * ```typescript
 * const compiled = defineWorkflow('simple', {
 *   steps: [
 *     { fn: step1, name: 'step1' },
 *     { fn: step2, name: 'step2' },
 *   ],
 * });
 * ```
 */
export function defineWorkflow(
	name: string,
	definition: Omit<WorkflowDefinition, "name">,
): CompiledWorkflow {
	return compileWorkflow({ name, ...definition });
}
