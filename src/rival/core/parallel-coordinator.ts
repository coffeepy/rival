import { actor } from "rivetkit";
import type { ParallelPlanNode } from "../types";

export interface ParallelCoordinatorState {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	workflowId: string;
	error: string | null;
}

export interface ParallelExecutionKickoffResult {
	status: "running";
}

export function createParallelCoordinator(_workflowName: string, node: ParallelPlanNode) {
	return actor({
		state: {
			status: "pending" as ParallelCoordinatorState["status"],
			workflowId: "",
			error: null as string | null,
		},
		actions: {
			runParallel: async (c, workflowId: string): Promise<ParallelExecutionKickoffResult> => {
				c.state.status = "running";
				c.state.workflowId = workflowId;
				c.state.error = `Parallel node \"${node.alias}\" is not enabled in this build.`;
				c.state.status = "failed";
				return { status: "running" };
			},
			getState: (c): ParallelCoordinatorState => ({
				status: c.state.status,
				workflowId: c.state.workflowId,
				error: c.state.error,
			}),
		},
	});
}
