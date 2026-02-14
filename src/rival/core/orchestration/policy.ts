import type { WorkflowRunResult } from "../actor-handles";

export type ChildTerminalStatus = "completed" | "failed" | "cancelled";

export function isHardChildStatus(status: ChildTerminalStatus): boolean {
	return status === "failed" || status === "cancelled";
}

export function isHardStepStatus(
	status: "completed" | "failed" | "skipped" | "cancelled",
	continueOnError?: boolean,
): boolean {
	return status === "cancelled" || (status === "failed" && !continueOnError);
}

export function isHardWorkflowResultStatus(status: WorkflowRunResult["status"]): boolean {
	return status === "failed" || status === "cancelled";
}

export function terminalError(
	status: "running" | "completed" | "failed" | "cancelled" | "skipped",
	failedMessage: string,
	cancelledMessage: string,
): string {
	return status === "cancelled" ? cancelledMessage : failedMessage;
}
