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
 * // compiled.plan = [{ type: 'step', id: 's1', alias: 'findTree', actorRef: 'tree_findTree' }, ...]
 * ```
 */

import { createForLoopCoordinator } from "../core/for-loop-coordinator";
import { createStepActor } from "../core/step-actor";
import { createWorkflowCoordinator } from "../core/workflow-coordinator";
import type {
	CompiledWorkflow,
	ForEachDefinition,
	LoopPlanNode,
	PlanNode,
	StepActorConfig,
	StepDefinition,
	StepFunction,
	StepPlanNode,
	WorkflowDefinition,
} from "../types";
import { validateForEachConcurrency } from "./for-each-validation";

const ACTION_TIMEOUT_BUFFER_MS = 1000;

/**
 * Type guard: is a step entry a ForEachDefinition?
 */
export function isForEachDefinition(
	entry: StepDefinition | ForEachDefinition,
): entry is ForEachDefinition {
	return "type" in entry && entry.type === "forEach";
}

/**
 * Type guard for forEach `run` shape.
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
	const { name, steps, inputSchema, onError, description } = definition;

	// Build actors and plan nodes
	const actors: Record<string, unknown> = {};

	function registerActor(ref: string, actorDef: unknown): void {
		if (ref in actors) {
			throw new Error(`Workflow "${name}" has duplicate actor ref: "${ref}"`);
		}
		actors[ref] = actorDef;
	}

	function validateUniqueIdentities(
		entries: (StepDefinition | ForEachDefinition)[],
		scope: string,
	): void {
		const seenIds = new Set<string>();
		const seenAliases = new Set<string>();
		for (const entry of entries) {
			if (seenIds.has(entry.id)) {
				throw new Error(
					`Workflow "${name}" has duplicate node id "${entry.id}" in ${scope}. Node ids must be unique within a scope.`,
				);
			}
			seenIds.add(entry.id);

			if (seenAliases.has(entry.alias)) {
				throw new Error(
					`Workflow "${name}" has duplicate alias "${entry.alias}" in ${scope}. Aliases must be unique within a scope.`,
				);
			}
			seenAliases.add(entry.alias);
		}
	}

	function prefixedRef(parts: string[]): string {
		return `${name}__${parts.join("__")}`;
	}

	function resolveActorConfig(
		stepAlias: string,
		config?: StepDefinition["config"],
	): StepActorConfig | undefined {
		if (!config) return undefined;

		if (config.timeout !== undefined && config.timeout <= 0) {
			throw new Error(
				`Workflow "${name}" step "${stepAlias}" has invalid timeout ${config.timeout}. Timeout must be > 0.`,
			);
		}
		const actorOptions: Record<string, unknown> = { ...(config.actor?.options ?? {}) };
		const rawActionTimeout = actorOptions.actionTimeout;
		if (
			rawActionTimeout !== undefined &&
			(typeof rawActionTimeout !== "number" || rawActionTimeout <= 0)
		) {
			throw new Error(
				`Workflow "${name}" step "${stepAlias}" has invalid actor.options.actionTimeout ${String(rawActionTimeout)}. actor.options.actionTimeout must be a positive number.`,
			);
		}

		// timeout is the single Rival timeout input. Ensure actor hard timeout
		// always expires after Rival's graceful timeout handler.
		if (config.timeout !== undefined) {
			actorOptions.actionTimeout = config.timeout + ACTION_TIMEOUT_BUFFER_MS;
		}

		return Object.keys(actorOptions).length > 0 ? { options: actorOptions } : undefined;
	}

	function compileEntries(
		entries: (StepDefinition | ForEachDefinition)[],
		scope: string,
		namespace: string[] = [],
	): PlanNode[] {
		validateUniqueIdentities(entries, scope);

		const compiled: PlanNode[] = [];

		for (const entry of entries) {
			if (isForEachDefinition(entry)) {
				validateForEachConcurrency(name, entry.alias, entry);

				const loopAlias = entry.alias;
				const loopNamespace = [...namespace, "loop", loopAlias];
				const iteratorActorRef = prefixedRef([...loopNamespace, "iterator"]);
				const loopCoordinatorActorRef = prefixedRef([...loopNamespace, "coordinator"]);
				registerActor(iteratorActorRef, createStepActor(entry.items));

				const runEntries: (StepDefinition | ForEachDefinition)[] = isWorkflowDefinition(entry.run)
					? entry.run.steps
					: [
							{
								id: `${entry.id}_run`,
								alias: entry.run.name || "run",
								run: entry.run,
							},
						];

				const runPlan = compileEntries(runEntries, `${scope} -> forEach("${loopAlias}") run`, [
					...loopNamespace,
					"run",
				]);

				const loopNode: LoopPlanNode = {
					type: "loop",
					id: entry.id,
					alias: entry.alias,
					name: entry.name,
					iteratorActorRef,
					loopCoordinatorActorRef,
					run: runPlan,
					parallel: entry.parallel,
					concurrency: entry.concurrency,
				};
				registerActor(loopCoordinatorActorRef, createForLoopCoordinator(name, loopNode));
				compiled.push(loopNode);
				continue;
			}

			const actorRef =
				namespace.length === 0
					? `${name}_${entry.alias}`
					: prefixedRef([...namespace, entry.alias]);
			const actorConfig = resolveActorConfig(entry.alias, entry.config);
			registerActor(actorRef, createStepActor(entry.run, actorConfig));

			const planNode: StepPlanNode = {
				type: "step",
				id: entry.id,
				alias: entry.alias,
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
	actors[coordinatorActorRef] = createWorkflowCoordinator(name, plan, inputSchema, onError);

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
 *     { id: 's1', alias: 'step1', run: step1 },
 *     { id: 's2', alias: 'step2', run: step2 },
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
