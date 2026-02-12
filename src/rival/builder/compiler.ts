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
 * // compiled.plan = [{ type: 'step', name: 'findTree', actorRef: 'tree_findTree' }, ...]
 * ```
 */

import { createStepActor } from "../core/step-actor";
import { createWorkflowCoordinator } from "../core/workflow-coordinator";
import type {
	CompiledWorkflow,
	ForEachDefinition,
	LoopPlanNode,
	PlanNode,
	StepDefinition,
	StepFunction,
	StepPlanNode,
	WorkflowDefinition,
} from "../types";

/**
 * Type guard: is a step entry a ForEachDefinition?
 */
export function isForEachDefinition(
	entry: StepDefinition | ForEachDefinition,
): entry is ForEachDefinition {
	return "type" in entry && entry.type === "forEach";
}

/**
 * Type guard for forEach `do` shape.
 */
function isWorkflowDefinition(
	value: StepFunction | WorkflowDefinition,
): value is WorkflowDefinition {
	return typeof value !== "function";
}

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

	// Build actors and plan nodes
	const actors: Record<string, unknown> = {};

	function registerActor(ref: string, actorDef: unknown): void {
		if (ref in actors) {
			throw new Error(`Workflow "${name}" has duplicate actor ref: "${ref}"`);
		}
		actors[ref] = actorDef;
	}

	function validateUniqueNames(
		entries: (StepDefinition | ForEachDefinition)[],
		scope: string,
	): void {
		const seen = new Set<string>();
		for (const entry of entries) {
			if (seen.has(entry.name)) {
				throw new Error(
					`Workflow "${name}" has duplicate step name "${entry.name}" in ${scope}. Step names must be unique within a scope.`,
				);
			}
			seen.add(entry.name);
		}
	}

	function prefixedRef(parts: string[]): string {
		return `${name}__${parts.join("__")}`;
	}

	function compileEntries(
		entries: (StepDefinition | ForEachDefinition)[],
		scope: string,
		namespace: string[] = [],
	): PlanNode[] {
		validateUniqueNames(entries, scope);

		const compiled: PlanNode[] = [];

		for (const entry of entries) {
			if (isForEachDefinition(entry)) {
				const loopName = entry.name;
				const loopNamespace = [...namespace, "loop", loopName];
				const iteratorActorRef = prefixedRef([...loopNamespace, "iterator"]);
				registerActor(iteratorActorRef, createStepActor(entry.items));

				const doEntries: (StepDefinition | ForEachDefinition)[] = isWorkflowDefinition(entry.do)
					? entry.do.steps
					: [{ fn: entry.do, name: entry.do.name || "do" }];

				const doPlan = compileEntries(doEntries, `${scope} -> forEach("${loopName}") do`, [
					...loopNamespace,
					"do",
				]);

				const loopNode: LoopPlanNode = {
					type: "loop",
					name: loopName,
					iteratorActorRef,
					do: doPlan,
					parallel: entry.parallel,
				};
				compiled.push(loopNode);
				continue;
			}

			const actorRef =
				namespace.length === 0 ? `${name}_${entry.name}` : prefixedRef([...namespace, entry.name]);
			registerActor(actorRef, createStepActor(entry.fn));

			const planNode: StepPlanNode = {
				type: "step",
				name: entry.name,
				actorRef,
				config: entry.config,
			};
			compiled.push(planNode);
		}

		return compiled;
	}

	const plan = compileEntries(steps, "top-level");

	// Create the coordinator actor
	const coordinatorActorRef = `${name}_coordinator`;
	actors[coordinatorActorRef] = createWorkflowCoordinator(name, plan, inputSchema);

	return {
		name,
		inputSchema,
		plan,
		actors,
		coordinatorActorRef,
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
