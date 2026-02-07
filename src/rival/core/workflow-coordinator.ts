/**
 * Workflow Coordinator Factory
 *
 * Creates the coordinator actor that orchestrates step execution.
 * Follows Rivet's Coordinator/Data pattern.
 */

import { actor } from "rivetkit";
import type { ZodSchema } from "zod";
import type { PlanNode, StepPlanNode, StepResult } from "../types";
import { buildStepContext } from "./context-builder";
import type { ExecuteContext, StepExecutionResult } from "./step-actor";

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
			 * Run the workflow with the given input.
			 */
			run: async (
				c,
				workflowId: string,
				rawInput: unknown = {},
			): Promise<WorkflowExecutionResult> => {
				// Prevent double-run
				if (c.state.status === "running") {
					throw new Error("Workflow already running");
				}

				// Validate input if schema provided
				let input: unknown = rawInput;
				if (inputSchema) {
					const parseResult = inputSchema.safeParse(rawInput);
					if (!parseResult.success) {
						c.state.status = "failed";
						c.state.error = `Input validation failed: ${parseResult.error.message}`;
						return { status: "failed", error: c.state.error };
					}
					input = parseResult.data;
				}

				// Initialize state
				c.state.status = "running";
				c.state.workflowId = workflowId;
				c.state.input = input;
				c.state.startedAt = Date.now();
				c.state.stepResults = {};
				c.state.currentStepIndex = 0;

				const stepNodes = plan.filter((n): n is StepPlanNode => n.type === "step");
				const stepNames = stepNodes.map((n) => n.name);

				console.log(`[${workflowName}/${workflowId}] Starting workflow`);
				console.log(`[${workflowName}/${workflowId}] Plan: ${stepNames.join(" → ")}`);

				const client = c.client();

				// Execute plan nodes sequentially
				for (let i = 0; i < plan.length; i++) {
					const node = plan[i];
					if (!node || node.type !== "step") {
						// TODO: Handle branch, loop, parallel in future phases
						continue;
					}

					c.state.currentStepIndex = i;
					console.log(`[${workflowName}/${workflowId}] Executing: ${node.name}`);

					// Get the step actor type from client using dynamic property access
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

						console.log(`[${workflowName}/${workflowId}] Failed: ${c.state.error}`);
						return { status: "failed", error: c.state.error, failedStep: node.name };
					}

					// Create step instance with unique key
					const stepKey = `${workflowId}-${node.name}`;
					const stepActor = stepActorType.getOrCreate(stepKey);

					// Build context from current workflow state
					const context = buildStepContext({
						input: c.state.input,
						stepResults: c.state.stepResults,
					});

					// Execute step
					const result = await stepActor.execute(context, node.config, workflowId, node.name);

					// Handle result
					if (result.status === "failed") {
						c.state.status = "failed";
						c.state.error = result.error ?? "Step failed";
						c.state.failedStep = node.name;
						c.state.completedAt = Date.now();

						console.log(`[${workflowName}/${workflowId}] Failed at step: ${node.name}`);
						return {
							status: "failed",
							error: result.error,
							failedStep: node.name,
							results: c.state.stepResults,
						};
					}

					// Store step result
					c.state.stepResults[node.name] = {
						result: result.result,
						state: result.stepState,
						status: result.status,
					};

					console.log(`[${workflowName}/${workflowId}] Completed: ${node.name}`);
				}

				// All steps completed
				c.state.status = "completed";
				c.state.completedAt = Date.now();

				console.log(`[${workflowName}/${workflowId}] Workflow completed!`);
				return { status: "completed", results: c.state.stepResults };
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
			 */
			cancel: async (c) => {
				if (c.state.status !== "running") {
					return;
				}

				c.state.status = "cancelled";
				c.state.completedAt = Date.now();

				// Note: Cannot truly cancel in-flight step execution,
				// but we mark workflow as cancelled to prevent further steps.
				console.log(`[${workflowName}/${c.state.workflowId}] Workflow cancelled`);
			},
		},
	});
}
