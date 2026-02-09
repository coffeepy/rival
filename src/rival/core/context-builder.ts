/**
 * Context Builder
 *
 * Pure function to build StepContext from workflow state.
 */

import type { LastStepInfo, StepContext, StepResult, StepState } from "../types";

/**
 * Workflow state needed to build step context.
 */
export interface WorkflowState {
	input: unknown;
	stepResults: Record<string, StepResult>;
}

/**
 * Builds a StepContext (without log and state) from workflow state.
 * The step actor will add log and state.
 *
 * @param workflowState - Current workflow state
 * @returns Partial context (missing log and state which are added by step actor)
 */
export function buildStepContext(workflowState: WorkflowState): Omit<StepContext, "log" | "state"> {
	const stepNames = Object.keys(workflowState.stepResults);
	const lastStepName = stepNames[stepNames.length - 1] ?? null;
	const lastStepData = lastStepName ? workflowState.stepResults[lastStepName] : null;

	const lastStep: LastStepInfo = {
		result: lastStepData?.result,
		state: lastStepData?.state ?? {},
		stepName: lastStepName,
	};

	return {
		input: workflowState.input,
		steps: workflowState.stepResults,
		lastStep,
	};
}

/**
 * Creates an empty step state object.
 */
export function createEmptyStepState(): StepState {
	return {};
}
