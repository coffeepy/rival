/**
 * Workflow Registry
 *
 * Manages compiled workflows and provides runtime operations.
 *
 * Two components:
 * 1. WorkflowRegistry class - In-memory storage for compiled workflows
 * 2. createRegistryActor - Rivet actor for runtime operations (live-query pattern)
 */

import { actor } from "rivetkit";
import type { CompiledWorkflow, StepResult, WorkflowMetadata } from "../types";
import type { WorkflowCoordinatorState } from "./workflow-coordinator";

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
 * Lightweight launch metadata stored in the registry actor.
 * Status is NOT stored here — it's queried live from the coordinator.
 */
export interface ActiveRun {
	runId: string;
	workflowName: string;
	startedAt: number;
	input: unknown;
}

/**
 * Combined view returned by getRunStatus — merges launch metadata
 * with live coordinator state.
 */
export interface RunStatusInfo {
	runId: string;
	workflowName: string;
	status: WorkflowCoordinatorState["status"];
	startedAt: number;
	completedAt: number | null;
	input: unknown;
	stepResults: Record<string, StepResult>;
	error: string | null;
	failedStep: string | null;
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

/** Type alias for coordinator actor handle. */
type CoordinatorHandle = {
	start: (id: string, input: unknown) => Promise<{ started: true }>;
	getState: () => Promise<WorkflowCoordinatorState & { duration: number | null }>;
	cancel: () => Promise<{ cancelled: boolean }>;
};

/**
 * Creates the registry actor for runtime workflow operations.
 * Uses the live-query pattern: status is always fetched from the coordinator.
 *
 * @param registry - The workflow registry to use
 */
export function createRegistryActor(registry: WorkflowRegistry = workflowRegistry) {
	/**
	 * Helper to resolve the coordinator actor name for a given workflow.
	 * Always derives from the registry class (closure), never from serialized state.
	 */
	function resolveCoordinatorName(workflowName: string): string | undefined {
		return registry.get(workflowName)?.coordinatorActorName;
	}

	/** Helper to get a coordinator handle from the client. */
	function getCoordinator(
		client: Record<string, unknown>,
		workflowName: string,
		runId: string,
	): CoordinatorHandle | undefined {
		const coordinatorActorName = resolveCoordinatorName(workflowName);
		if (!coordinatorActorName) return undefined;

		const coordinatorType = client[coordinatorActorName] as
			| { getOrCreate: (key: string) => CoordinatorHandle }
			| undefined;

		return coordinatorType?.getOrCreate(runId);
	}

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
			 * Calls coordinator.start() (returns immediately) — no fire-and-forget.
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

				const client = c.client() as Record<string, unknown>;
				const coordinator = getCoordinator(client, workflowName, id);

				if (!coordinator) {
					return {
						runId: id,
						workflowName,
						status: "failed",
						error: `Coordinator for "${workflowName}" not found in registry`,
					};
				}

				// Start the workflow — coordinator.start() returns immediately
				try {
					await coordinator.start(id, input);
				} catch (err) {
					return {
						runId: id,
						workflowName,
						status: "failed",
						error: err instanceof Error ? err.message : String(err),
					};
				}

				// Record launch metadata (no status — queried live)
				c.state.activeRuns[id] = {
					runId: id,
					workflowName,
					startedAt: Date.now(),
					input,
				};

				return {
					runId: id,
					workflowName,
					status: "started",
				};
			},

			/**
			 * Get the status of a specific run by querying the coordinator live.
			 */
			getRunStatus: async (c, runId: string): Promise<RunStatusInfo | undefined> => {
				const run = c.state.activeRuns[runId];
				if (!run) {
					return undefined;
				}

				const client = c.client() as Record<string, unknown>;
				const coordinator = getCoordinator(client, run.workflowName, runId);

				if (!coordinator) {
					return {
						runId,
						workflowName: run.workflowName,
						status: "failed",
						startedAt: run.startedAt,
						completedAt: null,
						input: run.input,
						stepResults: {},
						error: `Coordinator "${run.workflowName}" unreachable`,
						failedStep: null,
					};
				}

				try {
					const coordState = await coordinator.getState();
					return {
						runId,
						workflowName: run.workflowName,
						status: coordState.status,
						startedAt: coordState.startedAt ?? run.startedAt,
						completedAt: coordState.completedAt,
						input: coordState.input,
						stepResults: coordState.stepResults,
						error: coordState.error,
						failedStep: coordState.failedStep,
					};
				} catch (err) {
					return {
						runId,
						workflowName: run.workflowName,
						status: "failed",
						startedAt: run.startedAt,
						completedAt: null,
						input: run.input,
						stepResults: {},
						error: `Coordinator query failed: ${err instanceof Error ? err.message : String(err)}`,
						failedStep: null,
					};
				}
			},

			/**
			 * Get all active runs, optionally filtered by workflow name.
			 * Queries each coordinator for live status.
			 */
			getActiveRuns: async (c, workflowName?: string): Promise<RunStatusInfo[]> => {
				let runs = Object.values(c.state.activeRuns);
				if (workflowName) {
					runs = runs.filter((r) => r.workflowName === workflowName);
				}

				const client = c.client() as Record<string, unknown>;

				return Promise.all(
					runs.map(async (run): Promise<RunStatusInfo> => {
						const coordinator = getCoordinator(client, run.workflowName, run.runId);

						if (!coordinator) {
							return {
								runId: run.runId,
								workflowName: run.workflowName,
								status: "failed",
								startedAt: run.startedAt,
								completedAt: null,
								input: run.input,
								stepResults: {},
								error: `Coordinator "${run.workflowName}" unreachable`,
								failedStep: null,
							};
						}

						try {
							const coordState = await coordinator.getState();
							return {
								runId: run.runId,
								workflowName: run.workflowName,
								status: coordState.status,
								startedAt: coordState.startedAt ?? run.startedAt,
								completedAt: coordState.completedAt,
								input: coordState.input,
								stepResults: coordState.stepResults,
								error: coordState.error,
								failedStep: coordState.failedStep,
							};
						} catch {
							return {
								runId: run.runId,
								workflowName: run.workflowName,
								status: "failed",
								startedAt: run.startedAt,
								completedAt: null,
								input: run.input,
								stepResults: {},
								error: "Coordinator unreachable",
								failedStep: null,
							};
						}
					}),
				);
			},

			/**
			 * Cancel a running workflow.
			 */
			cancel: async (c, runId: string): Promise<{ success: boolean; error?: string }> => {
				const run = c.state.activeRuns[runId];
				if (!run) {
					return { success: false, error: `Run "${runId}" not found` };
				}

				const client = c.client() as Record<string, unknown>;
				const coordinator = getCoordinator(client, run.workflowName, runId);

				if (!coordinator) {
					return { success: false, error: "Coordinator not found" };
				}

				const cancelResult = await coordinator.cancel();

				if (cancelResult.cancelled) {
					return { success: true };
				}

				return { success: false, error: `Run "${runId}" is no longer running` };
			},

			/**
			 * Clean up completed runs older than the specified age.
			 * Queries each coordinator to check terminal status.
			 */
			cleanup: async (c, maxAgeMs = 3600000): Promise<{ removed: number }> => {
				const now = Date.now();
				const client = c.client() as Record<string, unknown>;
				const entries = Object.entries(c.state.activeRuns);

				// Query all coordinators in parallel, collect IDs to remove
				const idsToRemove = await Promise.all(
					entries.map(async ([runId, run]): Promise<string | null> => {
						const coordinator = getCoordinator(client, run.workflowName, runId);
						if (!coordinator) {
							return now - run.startedAt > maxAgeMs ? runId : null;
						}

						try {
							const coordState = await coordinator.getState();
							const isTerminal = ["completed", "failed", "cancelled"].includes(coordState.status);
							if (isTerminal && coordState.completedAt && now - coordState.completedAt > maxAgeMs) {
								return runId;
							}
							return null;
						} catch {
							return now - run.startedAt > maxAgeMs ? runId : null;
						}
					}),
				);

				// Apply removals synchronously
				let removed = 0;
				for (const id of idsToRemove) {
					if (id) {
						delete c.state.activeRuns[id];
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
