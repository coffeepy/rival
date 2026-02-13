/**
 * Context Builder
 *
 * Pure function to build StepContext from workflow state.
 */

import type { LastStepInfo, LoopContext, StepContext, StepResult, StepState } from "../types";

/**
 * Workflow state needed to build step context.
 */
export interface WorkflowState {
	input: unknown;
	stepResults: Record<string, StepResult>;
	loopContext?: LoopContext;
}

/**
 * Builds a StepContext (without log and state) from workflow state.
 * The step actor will add log and state.
 *
 * @param workflowState - Current workflow state
 * @returns Partial context (missing log and state which are added by step actor)
 */
export function buildStepContext(workflowState: WorkflowState): Omit<StepContext, "log" | "state"> {
	const aliases = Object.keys(workflowState.stepResults);
	const lastAlias = aliases[aliases.length - 1] ?? null;
	const lastStepData = lastAlias ? workflowState.stepResults[lastAlias] : null;

	const lastStep: LastStepInfo = {
		result: lastStepData?.result,
		state: lastStepData?.state ?? {},
		alias: lastAlias,
	};

	const ctx: Omit<StepContext, "log" | "state"> = {
		input: workflowState.input,
		steps: workflowState.stepResults,
		lastStep,
		...(workflowState.loopContext ? { loop: workflowState.loopContext } : {}),
	};

	return ctx;
}

/**
 * Creates an empty step state object.
 */
export function createEmptyStepState(): StepState {
	return {};
}
