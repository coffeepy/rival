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
import { createParallelCoordinator } from "../core/parallel-coordinator";
import { createStepActor } from "../core/step-actor";
import { createWorkflowCoordinator } from "../core/workflow-coordinator";
import type {
	CompiledWorkflow,
	ConcurrentDefinition,
	ConcurrentStepDefinition,
	ForEachDefinition,
	LoopPlanNode,
	ParallelPlanNode,
	PlanNode,
	StepActorConfig,
	StepDefinition,
	StepFunction,
	StepPlanNode,
	WorkflowDefinition,
	WorkflowPlanNode,
} from "../types";
import {
	validateConcurrentConfig,
	validateConcurrentWorkflowChildConfig,
} from "./concurrent-validation";
import { validateForEachConcurrency } from "./for-each-validation";

const ACTION_TIMEOUT_BUFFER_MS = 1000;

/**
 * Type guard: is a step entry a ForEachDefinition?
 */
export function isForEachDefinition(
	entry: StepDefinition | ForEachDefinition | ConcurrentDefinition,
): entry is ForEachDefinition {
	return "type" in entry && entry.type === "forEach";
}

function isConcurrentDefinition(
	entry: StepDefinition | ForEachDefinition | ConcurrentDefinition,
): entry is ConcurrentDefinition {
	return "type" in entry && entry.type === "concurrent";
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
		entries: (StepDefinition | ForEachDefinition | ConcurrentDefinition)[],
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

	function validateConcurrentChildIdentities(
		steps: ConcurrentDefinition["steps"],
		scope: string,
	): void {
		const seenIds = new Set<string>();
		const seenAliases = new Set<string>();
		for (const step of steps) {
			if (seenIds.has(step.id)) {
				throw new Error(
					`Workflow "${name}" has duplicate concurrent child id "${step.id}" in ${scope}. Child ids must be unique within a concurrent block.`,
				);
			}
			seenIds.add(step.id);

			if (seenAliases.has(step.alias)) {
				throw new Error(
					`Workflow "${name}" has duplicate concurrent child alias "${step.alias}" in ${scope}. Child aliases must be unique within a concurrent block.`,
				);
			}
			seenAliases.add(step.alias);
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
		entries: (StepDefinition | ForEachDefinition | ConcurrentDefinition)[],
		scope: string,
		namespace: string[] = [],
	): PlanNode[] {
		validateUniqueIdentities(entries, scope);

		const compiled: PlanNode[] = [];

		function compileConcurrentStepEntry(
			entry: ConcurrentStepDefinition,
			concurrentScope: string,
			concurrentNamespace: string[],
		): PlanNode {
			// Concurrent `run` supports both step functions and nested workflows.
			// We lower workflows to a child workflow coordinator node.
			if (isWorkflowDefinition(entry.run)) {
				validateConcurrentWorkflowChildConfig(name, concurrentScope, entry.alias, entry.config);
				const workflowNamespace = [...concurrentNamespace, "workflow", entry.alias];
				const nestedPlan = compileEntries(
					entry.run.steps,
					`${concurrentScope} -> workflow("${entry.alias}")`,
					workflowNamespace,
				);
				const coordinatorActorRef = prefixedRef([...workflowNamespace, "coordinator"]);
				registerActor(
					coordinatorActorRef,
					createWorkflowCoordinator(
						`${name}/${entry.alias}`,
						nestedPlan,
						entry.run.inputSchema,
						entry.run.onError,
					),
				);
				const workflowNode: WorkflowPlanNode = {
					type: "workflow",
					id: entry.id,
					alias: entry.alias,
					name: entry.name ?? entry.run.name,
					coordinatorActorRef,
				};
				return workflowNode;
			}

			const actorRef = prefixedRef([...concurrentNamespace, entry.alias]);
			const actorConfig = resolveActorConfig(entry.alias, entry.config);
			registerActor(actorRef, createStepActor(entry.run, actorConfig));
			const stepNode: StepPlanNode = {
				type: "step",
				id: entry.id,
				alias: entry.alias,
				name: entry.name,
				actorRef,
				config: entry.config,
			};
			return stepNode;
		}

		for (const entry of entries) {
			if (isForEachDefinition(entry)) {
				validateForEachConcurrency(name, entry.alias, entry);

				const loopAlias = entry.alias;
				const loopNamespace = [...namespace, "loop", loopAlias];
				const iteratorActorRef = prefixedRef([...loopNamespace, "iterator"]);
				const loopCoordinatorActorRef = prefixedRef([...loopNamespace, "coordinator"]);
				registerActor(iteratorActorRef, createStepActor(entry.items));

				const runEntries: (StepDefinition | ForEachDefinition | ConcurrentDefinition)[] =
					isWorkflowDefinition(entry.run)
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

			if (isConcurrentDefinition(entry)) {
				validateConcurrentConfig(name, entry.alias, entry);
				validateConcurrentChildIdentities(entry.steps, `${scope} -> concurrent("${entry.alias}")`);
				const parallelNamespace = [...namespace, "parallel", entry.alias];
				const parallelCoordinatorActorRef = prefixedRef([...parallelNamespace, "coordinator"]);
				const parallelSteps = entry.steps.map((stepEntry) =>
					compileConcurrentStepEntry(stepEntry, `${scope} -> concurrent("${entry.alias}")`, [
						...parallelNamespace,
						"step",
					]),
				);
				const parallelNode: ParallelPlanNode = {
					type: "parallel",
					id: entry.id,
					alias: entry.alias,
					name: entry.name,
					continueOn: entry.continueOn ?? "all",
					onFailure: entry.onFailure ?? "fail",
					parallelCoordinatorActorRef,
					steps: parallelSteps,
				};
				registerActor(parallelCoordinatorActorRef, createParallelCoordinator(name, parallelNode));
				compiled.push(parallelNode);
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
