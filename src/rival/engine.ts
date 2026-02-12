/**
 * Rival Engine - Top-Level Convenience API
 *
 * Provides a single `rival()` function that hides all the plumbing
 * of compiling, registering, and setting up rivetkit.
 *
 * @example
 * ```typescript
 * const engine = rival(workflow1, workflow2);
 * const { runId } = await engine.run("workflow1", { input });
 * const result = await engine.wait("workflow1", runId);
 * ```
 */

import { createFileSystemDriver, setup } from "rivetkit";
import { compileWorkflow } from "./builder/compiler";
import type {
	WorkflowCoordinatorState,
	WorkflowExecutionResult,
} from "./core/workflow-coordinator";
import type { CompiledWorkflow, WorkflowDefinition } from "./types";

export interface WaitOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export interface WorkflowRunStartResult {
	runId: string;
	status: "started" | "running";
}

/**
 * A coordinator instance for a specific workflow run.
 *
 * `run()` starts asynchronously and returns immediately.
 * Use `wait()` to resolve terminal workflow results.
 */
export interface CoordinatorInstance {
	run: (runId: string, input: unknown) => Promise<WorkflowRunStartResult>;
	wait: (options?: WaitOptions) => Promise<WorkflowExecutionResult>;
	cancel: () => Promise<void>;
	getState: () => Promise<WorkflowCoordinatorState & { duration: number | null }>;
}

/**
 * A coordinator actor type for a workflow.
 * Returned by `engine.get()` — call `getOrCreate(runId)` to get a run instance.
 */
export interface CoordinatorHandle {
	getOrCreate: (runId: string) => CoordinatorInstance;
}

interface RawCoordinatorHandle {
	getOrCreate: (runId: string) => {
		run: (runId: string, input: unknown) => Promise<WorkflowExecutionResult>;
		cancel: () => Promise<void>;
		getState: () => Promise<WorkflowCoordinatorState & { duration: number | null }>;
	};
}

/**
 * Type guard: is this a CompiledWorkflow (has actors + coordinatorActorRef)?
 */
function isCompiledWorkflow(w: WorkflowDefinition | CompiledWorkflow): w is CompiledWorkflow {
	return "actors" in w && "coordinatorActorRef" in w;
}

/**
 * Private registry that collects actors from compiled workflows,
 * checking for duplicate workflow names and actor names.
 */
class ActorRegistry {
	private workflowNames = new Set<string>();
	private actors: Record<string, unknown> = {};

	register(workflow: CompiledWorkflow): void {
		if (this.workflowNames.has(workflow.name)) {
			throw new Error(`Workflow "${workflow.name}" is already registered`);
		}
		this.workflowNames.add(workflow.name);

		for (const [actorName, actorDef] of Object.entries(workflow.actors)) {
			if (this.actors[actorName]) {
				throw new Error(`Duplicate actor name: ${actorName}`);
			}
			this.actors[actorName] = actorDef;
		}
	}

	getAllActors(): Record<string, unknown> {
		return { ...this.actors };
	}
}

/**
 * A running workflow engine with registered workflows.
 */
export class RivalEngine {
	private static readonly WAIT_TIMEOUT_MS = 300_000;
	private static readonly WAIT_POLL_INTERVAL_MS = 250;

	private client: Record<string, unknown>;
	private compiledWorkflows: Map<string, CompiledWorkflow>;

	constructor(client: Record<string, unknown>, compiledWorkflows: Map<string, CompiledWorkflow>) {
		this.client = client;
		this.compiledWorkflows = compiledWorkflows;
	}

	/**
	 * Run a workflow by name.
	 *
	 * @param workflowName - Name of the registered workflow
	 * @param input - Input data for the workflow
	 * @param runId - Optional run ID (auto-generated if not provided)
	 * @returns start metadata ({ runId, status })
	 */
	async run(
		workflowName: string,
		input?: unknown,
		runId?: string,
	): Promise<WorkflowRunStartResult> {
		const id = runId ?? `${workflowName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const coord = this.get(workflowName);
		const instance = coord.getOrCreate(id);
		await instance.run(id, input === undefined ? {} : input);
		return { runId: id, status: "started" };
	}

	/**
	 * Wait for a workflow run to reach terminal status.
	 */
	async wait(
		workflowName: string,
		runId: string,
		options?: WaitOptions,
	): Promise<WorkflowExecutionResult> {
		const coord = this.get(workflowName);
		const instance = coord.getOrCreate(runId);
		return this.waitForTerminal(instance.getState, workflowName, runId, options);
	}

	private async waitForTerminal(
		getState: CoordinatorInstance["getState"],
		workflowName: string,
		runId: string,
		options?: WaitOptions,
	): Promise<WorkflowExecutionResult> {
		const timeoutMs = options?.timeoutMs ?? RivalEngine.WAIT_TIMEOUT_MS;
		const pollIntervalMs = options?.pollIntervalMs ?? RivalEngine.WAIT_POLL_INTERVAL_MS;
		const startedAt = Date.now();

		for (;;) {
			const elapsed = Date.now() - startedAt;
			if (elapsed > timeoutMs) {
				throw new Error(
					`Timed out waiting for workflow "${workflowName}" run "${runId}" after ${timeoutMs}ms`,
				);
			}

			const state = await getState();
			if (state.status === "pending" || state.status === "running") {
				await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
				continue;
			}

			if (state.status === "completed") {
				return { status: "completed", results: state.stepResults };
			}
			if (state.status === "failed") {
				return {
					status: "failed",
					error: state.error ?? `Workflow "${workflowName}" run "${runId}" failed`,
					failedStep: state.failedStep ?? undefined,
					results: state.stepResults,
				};
			}
			if (state.status === "cancelled") {
				return { status: "cancelled", results: state.stepResults };
			}

			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}

	/**
	 * Get the coordinator for a workflow.
	 *
	 * Escape hatch for advanced usage — call `getOrCreate(runId)` on the
	 * returned handle to get a run instance with `run`, `wait`, `cancel`, `getState`.
	 *
	 * @param workflowName - Name of the registered workflow
	 * @returns The coordinator handle
	 */
	get(workflowName: string): CoordinatorHandle {
		const compiled = this.compiledWorkflows.get(workflowName);
		if (!compiled) {
			const available = this.list();
			throw new Error(
				`Workflow "${workflowName}" not found. Available workflows: ${available.length > 0 ? available.join(", ") : "(none)"}`,
			);
		}

		const coordinatorType = this.client[compiled.coordinatorActorRef] as
			| RawCoordinatorHandle
			| undefined;

		if (!coordinatorType) {
			throw new Error(`Coordinator "${compiled.coordinatorActorRef}" not found in runtime`);
		}

		return {
			getOrCreate: (runId: string): CoordinatorInstance => {
				const rawInstance = coordinatorType.getOrCreate(runId);
				return {
					run: async (rawRunId: string, input: unknown): Promise<WorkflowRunStartResult> => {
						const runResult = await rawInstance.run(rawRunId, input);
						if (runResult.status === "failed") {
							throw new Error(runResult.error ?? `Workflow "${workflowName}" failed to start`);
						}
						return { runId: rawRunId, status: "running" };
					},
					wait: (options?: WaitOptions) =>
						this.waitForTerminal(rawInstance.getState, workflowName, runId, options),
					cancel: rawInstance.cancel,
					getState: rawInstance.getState,
				};
			},
		};
	}

	/**
	 * List registered workflow names.
	 */
	list(): string[] {
		return Array.from(this.compiledWorkflows.keys());
	}
}

/**
 * Create a Rival engine from one or more workflows.
 *
 * Accepts WorkflowDefinition (from builder) or CompiledWorkflow (pre-compiled).
 * Compiles definitions automatically, registers all workflows, starts rivetkit
 * headless, and returns a RivalEngine ready for `engine.run()`.
 *
 * @example
 * ```typescript
 * const engine = rival(workflow1, workflow2);
 * const { runId } = await engine.run("workflow1", { location: "forest" });
 * const result = await engine.wait("workflow1", runId);
 * console.log(result.status); // "completed"
 * ```
 */
export function rival(...workflows: (WorkflowDefinition | CompiledWorkflow)[]): RivalEngine {
	const registry = new ActorRegistry();
	const compiledWorkflows = new Map<string, CompiledWorkflow>();

	for (const w of workflows) {
		const compiled = isCompiledWorkflow(w) ? w : compileWorkflow(w);
		registry.register(compiled);
		compiledWorkflows.set(compiled.name, compiled);
	}

	const rivet = setup({
		use: {
			...registry.getAllActors(),
		} as Parameters<typeof setup>[0]["use"],
	});

	const isolatedStoragePath = `/tmp/rival-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const { client } = rivet.start({
		driver: createFileSystemDriver({ path: isolatedStoragePath }),
		disableDefaultServer: true,
		noWelcome: true,
	});

	return new RivalEngine(client as Record<string, unknown>, compiledWorkflows);
}
