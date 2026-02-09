/**
 * Workflow Registry
 *
 * Manages compiled workflows and provides runtime operations.
 *
 * Two components:
 * 1. WorkflowRegistry class - In-memory storage for compiled workflows
 * 2. createRegistryActor - Rivet actor for runtime operations
 */

import { actor } from "rivetkit";
import type { CompiledWorkflow, WorkflowMetadata } from "../types";
import type { WorkflowExecutionResult } from "./workflow-coordinator";

/**
 * In-memory registry for compiled workflows.
 * This is NOT an actor - it's a simple class for workflow storage.
 */
export class WorkflowRegistry {
	private workflows: Map<string, CompiledWorkflow> = new Map();

	/**
	 * Register a compiled workflow.
	 */
	register(workflow: CompiledWorkflow): void {
		if (this.workflows.has(workflow.name)) {
			throw new Error(`Workflow "${workflow.name}" is already registered`);
		}
		this.workflows.set(workflow.name, workflow);
	}

	/**
	 * Get a compiled workflow by name.
	 */
	get(name: string): CompiledWorkflow | undefined {
		return this.workflows.get(name);
	}

	/**
	 * Check if a workflow is registered.
	 */
	has(name: string): boolean {
		return this.workflows.has(name);
	}

	/**
	 * List all registered workflows with metadata.
	 */
	list(): WorkflowMetadata[] {
		return Array.from(this.workflows.values()).map((w) => ({
			name: w.name,
			description: w.description,
			stepCount: w.plan.filter((n) => n.type === "step").length,
			inputJsonSchema: undefined, // TODO: Convert Zod to JSON Schema
		}));
	}

	/**
	 * Get all actor definitions from all registered workflows.
	 * Used to register with RivetKit.
	 */
	getAllActors(): Record<string, unknown> {
		const allActors: Record<string, unknown> = {};

		for (const workflow of this.workflows.values()) {
			for (const [actorName, actorDef] of Object.entries(workflow.actors)) {
				if (allActors[actorName]) {
					throw new Error(`Duplicate actor name: ${actorName}`);
				}
				allActors[actorName] = actorDef;
			}
		}

		return allActors;
	}

	/**
	 * Get the names of all registered workflows.
	 */
	getWorkflowNames(): string[] {
		return Array.from(this.workflows.keys());
	}

	/**
	 * Clear all registered workflows.
	 * Useful for testing.
	 */
	clear(): void {
		this.workflows.clear();
	}
}

/**
 * Global workflow registry instance.
 */
export const workflowRegistry = new WorkflowRegistry();

/**
 * Information about an active workflow run.
 */
export interface ActiveRun {
	runId: string;
	workflowName: string;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
	completedAt?: number;
	input: unknown;
}

/**
 * Registry actor state.
 */
export interface RegistryActorState {
	activeRuns: Record<string, ActiveRun>;
}

/**
 * Result of launching a workflow.
 */
export interface LaunchResult {
	runId: string;
	workflowName: string;
	status: "started" | "failed";
	error?: string;
}

/**
 * Creates the registry actor for runtime workflow operations.
 *
 * @param registry - The workflow registry to use
 */
export function createRegistryActor(registry: WorkflowRegistry = workflowRegistry) {
	return actor({
		state: {
			activeRuns: {} as Record<string, ActiveRun>,
		},

		actions: {
			/**
			 * List all registered workflows.
			 */
			list: (): WorkflowMetadata[] => {
				return registry.list();
			},

			/**
			 * Launch a workflow by name.
			 */
			launch: async (
				c,
				workflowName: string,
				input: unknown = {},
				runId?: string,
			): Promise<LaunchResult> => {
				const workflow = registry.get(workflowName);
				if (!workflow) {
					return {
						runId: "",
						workflowName,
						status: "failed",
						error: `Workflow "${workflowName}" not found`,
					};
				}

				// Generate run ID if not provided
				const id =
					runId ?? `${workflowName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

				// Record the run
				c.state.activeRuns[id] = {
					runId: id,
					workflowName,
					status: "running",
					startedAt: Date.now(),
					input,
				};

				// Get the coordinator and start it
				const client = c.client();
				const coordinatorType = (client as Record<string, unknown>)[workflow.coordinatorActorRef] as
					| {
							getOrCreate: (key: string) => {
								run: (id: string, input: unknown) => Promise<WorkflowExecutionResult>;
							};
					  }
					| undefined;

				if (!coordinatorType) {
					c.state.activeRuns[id].status = "failed";
					return {
						runId: id,
						workflowName,
						status: "failed",
						error: `Coordinator "${workflow.coordinatorActorRef}" not found in registry`,
					};
				}

				// Start the workflow asynchronously
				const coordinator = coordinatorType.getOrCreate(id);

				// Don't await - let it run in background
				coordinator
					.run(id, input)
					.then((result) => {
						if (c.state.activeRuns[id]) {
							c.state.activeRuns[id].status = result.status;
							c.state.activeRuns[id].completedAt = Date.now();
						}
					})
					.catch((err: Error) => {
						if (c.state.activeRuns[id]) {
							c.state.activeRuns[id].status = "failed";
							c.state.activeRuns[id].completedAt = Date.now();
						}
						console.error(`[Registry] Workflow ${id} failed:`, err);
					});

				return {
					runId: id,
					workflowName,
					status: "started",
				};
			},

			/**
			 * Get the status of a specific run.
			 */
			getRunStatus: (c, runId: string): ActiveRun | undefined => {
				return c.state.activeRuns[runId];
			},

			/**
			 * Get all active runs, optionally filtered by workflow name.
			 */
			getActiveRuns: (c, workflowName?: string): ActiveRun[] => {
				const runs = Object.values(c.state.activeRuns);
				if (workflowName) {
					return runs.filter((r) => r.workflowName === workflowName);
				}
				return runs;
			},

			/**
			 * Cancel a running workflow.
			 */
			cancel: async (c, runId: string): Promise<{ success: boolean; error?: string }> => {
				const run = c.state.activeRuns[runId];
				if (!run) {
					return { success: false, error: `Run "${runId}" not found` };
				}

				if (run.status !== "running") {
					return { success: false, error: `Run "${runId}" is not running (status: ${run.status})` };
				}

				const workflow = registry.get(run.workflowName);
				if (!workflow) {
					return { success: false, error: `Workflow "${run.workflowName}" not found` };
				}

				// Get the coordinator and cancel it
				const client = c.client();
				const coordinatorType = (client as Record<string, unknown>)[workflow.coordinatorActorRef] as
					| {
							getOrCreate: (key: string) => {
								cancel: () => Promise<void>;
							};
					  }
					| undefined;

				if (!coordinatorType) {
					return { success: false, error: "Coordinator not found" };
				}

				const coordinator = coordinatorType.getOrCreate(runId);
				await coordinator.cancel();

				c.state.activeRuns[runId].status = "cancelled";
				c.state.activeRuns[runId].completedAt = Date.now();

				return { success: true };
			},

			/**
			 * Clean up completed runs older than the specified age.
			 */
			cleanup: (c, maxAgeMs = 3600000): { removed: number } => {
				const now = Date.now();
				let removed = 0;

				for (const [runId, run] of Object.entries(c.state.activeRuns)) {
					if (run.status !== "running" && run.completedAt && now - run.completedAt > maxAgeMs) {
						delete c.state.activeRuns[runId];
						removed++;
					}
				}

				return { removed };
			},
		},
	});
}

/**
 * Convenience function to register a workflow and return its compiled form.
 */
export function registerWorkflow(workflow: CompiledWorkflow): CompiledWorkflow {
	workflowRegistry.register(workflow);
	return workflow;
}
