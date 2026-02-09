/**
 * Workflow Coordinator Factory
 *
 * Creates the coordinator actor that orchestrates step execution.
 * Uses a schedule-driven state machine: each step is its own short-lived
 * action invocation, chained via c.schedule.after(1, "processNextStep").
 *
 * This avoids RivetKit's actionTimeout (60s) by never holding a single
 * action open for the entire workflow.
 */

import { actor } from "rivetkit";
import type { ZodSchema } from "zod";
import type { PlanNode, StepPlanNode, StepResult } from "../types";
import { planSchema } from "../types";
import { buildStepContext } from "./context-builder";
import type { ExecuteContext, StepExecutionResult } from "./step-actor";

/** Default timeout for a single step execution (ms). */
const STEP_TIMEOUT_MS = 55_000;

/**
 * Workflow coordinator state.
 */
export interface WorkflowCoordinatorState {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	workflowId: string;
	input: unknown;
	stepResults: Record<string, StepResult>;
	currentStepIndex: number;
	startedAt: number | null;
	completedAt: number | null;
	error: string | null;
	failedStep: string | null;
}

/**
 * Result of workflow execution.
 * Kept for consumers who want to construct it from getState().
 * No action returns this directly anymore.
 */
export interface WorkflowExecutionResult {
	status: "completed" | "failed" | "cancelled";
	results?: Record<string, StepResult>;
	error?: string;
	failedStep?: string;
}

/**
 * Creates a workflow coordinator actor.
 *
 * @param workflowName - Name of the workflow
 * @param plan - The execution plan (array of PlanNodes)
 * @param inputSchema - Optional Zod schema for input validation
 */
export function createWorkflowCoordinator(
	workflowName: string,
	plan: PlanNode[],
	inputSchema?: ZodSchema,
) {
	// Validate plan structure and unique step names
	const result = planSchema.safeParse(plan);
	if (!result.success) {
		const messages = result.error.issues.map((i) => i.message).join("; ");
		throw new Error(`Workflow "${workflowName}" has an invalid plan: ${messages}`);
	}

	return actor({
		state: {
			status: "pending" as WorkflowCoordinatorState["status"],
			workflowId: "",
			input: {} as unknown,
			stepResults: {} as Record<string, StepResult>,
			currentStepIndex: 0,
			startedAt: null as number | null,
			completedAt: null as number | null,
			error: null as string | null,
			failedStep: null as string | null,
		},

		actions: {
			/**
			 * Start the workflow. Returns immediately.
			 * Kicks off the first step via c.schedule.after(1, "processNextStep").
			 */
			start: async (c, workflowId: string, rawInput: unknown = {}): Promise<{ started: true }> => {
				// Only allow starting from "pending" state
				if (c.state.status !== "pending") {
					throw new Error(
						c.state.status === "running"
							? "Workflow already running"
							: `Cannot start workflow in "${c.state.status}" state`,
					);
				}

				// Validate input if schema provided
				let input: unknown = rawInput;
				if (inputSchema) {
					const parseResult = inputSchema.safeParse(rawInput);
					if (!parseResult.success) {
						c.state.status = "failed";
						c.state.error = `Input validation failed: ${parseResult.error.message}`;
						c.state.completedAt = Date.now();
						throw new Error(c.state.error);
					}
					input = parseResult.data;
				}

				// Initialize state
				c.state.status = "running";
				c.state.workflowId = workflowId;
				c.state.input = input;
				c.state.startedAt = Date.now();
				c.state.completedAt = null;
				c.state.error = null;
				c.state.failedStep = null;
				c.state.stepResults = {};
				c.state.currentStepIndex = 0;

				const stepNodes = plan.filter((n): n is StepPlanNode => n.type === "step");
				const stepNames = stepNodes.map((n) => n.name);

				c.log.info(`[${workflowName}/${workflowId}] Starting workflow`);
				c.log.info(`[${workflowName}/${workflowId}] Plan: ${stepNames.join(" → ")}`);

				// Schedule first tick — LAST, after all state writes
				await c.schedule.after(1, "processNextStep");

				return { started: true };
			},

			/**
			 * Process exactly ONE step, then schedule the next tick.
			 * Entire body wrapped in try-catch to prevent permanent stall.
			 */
			processNextStep: async (c): Promise<void> => {
				let node: StepPlanNode | undefined;
				try {
					// Guard: not running → bail out
					if (c.state.status !== "running") {
						return;
					}

					// Find the next step node (skip non-step plan nodes)
					while (c.state.currentStepIndex < plan.length) {
						const candidate = plan[c.state.currentStepIndex];
						if (candidate && candidate.type === "step") {
							node = candidate;
							break;
						}
						// Skip non-step nodes (branch, loop, parallel — future phases)
						c.state.currentStepIndex++;
					}

					// No more steps → workflow completed
					if (!node) {
						c.state.status = "completed";
						c.state.completedAt = Date.now();
						c.log.info(`[${workflowName}/${c.state.workflowId}] Workflow completed!`);
						return;
					}

					c.log.info(`[${workflowName}/${c.state.workflowId}] Executing: ${node.name}`);

					// Look up step actor
					const client = c.client();
					const stepActorType = (client as Record<string, unknown>)[node.actorType] as
						| {
								getOrCreate: (key: string) => {
									execute: (
										ctx: ExecuteContext,
										config?: unknown,
										wfId?: string,
										stepName?: string,
									) => Promise<StepExecutionResult>;
								};
						  }
						| undefined;

					if (!stepActorType) {
						c.state.status = "failed";
						c.state.error = `Actor type "${node.actorType}" not found in registry`;
						c.state.failedStep = node.name;
						c.state.completedAt = Date.now();
						c.log.info(`[${workflowName}/${c.state.workflowId}] Failed: ${c.state.error}`);
						return;
					}

					// Create step instance with unique key
					const stepKey = `${c.state.workflowId}-${node.name}`;
					const stepActor = stepActorType.getOrCreate(stepKey);

					// Build context from current workflow state
					const context = buildStepContext({
						input: c.state.input,
						stepResults: c.state.stepResults,
					});

					// Execute step with explicit timeout (scheduled actions bypass actionTimeout)
					const stepTimeoutMs = node.config?.timeout ?? STEP_TIMEOUT_MS;
					let timeoutHandle: ReturnType<typeof setTimeout>;
					const timeoutPromise = new Promise<never>((_, reject) => {
						timeoutHandle = setTimeout(
							() => reject(new Error(`Step "${node!.name}" timed out after ${stepTimeoutMs}ms`)),
							stepTimeoutMs,
						);
					});

					let stepResult: StepExecutionResult;
					try {
						stepResult = await Promise.race([
							stepActor.execute(context, node.config, c.state.workflowId, node.name),
							timeoutPromise,
						]);
					} finally {
						clearTimeout(timeoutHandle!);
					}

					// Post-await cancellation check
					if (c.state.status === "cancelled") {
						// Store the result of the step that was running when cancel hit
						c.state.stepResults[node.name] = {
							result: stepResult.result,
							state: stepResult.stepState,
							status: stepResult.status,
						};
						c.log.info(
							`[${workflowName}/${c.state.workflowId}] Workflow cancelled after step: ${node.name}`,
						);
						return; // Don't schedule further
					}

					// Handle failure
					if (stepResult.status === "failed" && !stepResult.continueOnError) {
						c.state.status = "failed";
						c.state.error = stepResult.error ?? "Step failed";
						c.state.failedStep = node.name;
						c.state.completedAt = Date.now();
						c.log.info(`[${workflowName}/${c.state.workflowId}] Failed at step: ${node.name}`);
						return;
					}

					if (stepResult.status === "failed" && stepResult.continueOnError) {
						c.state.stepResults[node.name] = {
							result: stepResult.result,
							state: stepResult.stepState,
							status: "failed",
						};
						c.log.info(
							`[${workflowName}/${c.state.workflowId}] Step failed (continue): ${node.name}`,
						);
					} else {
						// Store step result
						c.state.stepResults[node.name] = {
							result: stepResult.result,
							state: stepResult.stepState,
							status: stepResult.status,
						};
						c.log.info(`[${workflowName}/${c.state.workflowId}] Completed: ${node.name}`);
					}

					// Advance to next step
					c.state.currentStepIndex++;

					// Schedule next tick — LAST, after all state writes and cancellation checks
					await c.schedule.after(1, "processNextStep");
				} catch (err) {
					// Catch-all: prevent permanent "running" stall
					const message = err instanceof Error ? err.message : String(err);
					c.state.status = "failed";
					c.state.error = message;
					if (node) {
						c.state.failedStep = node.name;
					}
					c.state.completedAt = Date.now();
					c.log.info(
						`[${workflowName}/${c.state.workflowId}] Unexpected error in processNextStep: ${message}`,
					);
				}
			},

			/**
			 * Get the current state of the workflow.
			 */
			getState: (c): WorkflowCoordinatorState & { duration: number | null } => ({
				status: c.state.status,
				workflowId: c.state.workflowId,
				input: c.state.input,
				stepResults: c.state.stepResults,
				currentStepIndex: c.state.currentStepIndex,
				startedAt: c.state.startedAt,
				completedAt: c.state.completedAt,
				error: c.state.error,
				failedStep: c.state.failedStep,
				duration:
					c.state.completedAt && c.state.startedAt ? c.state.completedAt - c.state.startedAt : null,
			}),

			/**
			 * Cancel the workflow.
			 * Returns { cancelled: true } if the workflow was running and is now cancelled.
			 */
			cancel: async (c): Promise<{ cancelled: boolean }> => {
				if (c.state.status !== "running") {
					return { cancelled: false };
				}

				c.state.status = "cancelled";
				c.state.completedAt = Date.now();

				c.log.info(`[${workflowName}/${c.state.workflowId}] Workflow cancelled`);
				return { cancelled: true };
			},
		},
	});
}
