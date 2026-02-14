import type { LoopContext, StepResult } from "../types";
import type { ExecuteContext, StepExecutionKickoffResult } from "./step-actor";

export interface RunningKickoffResult {
	status: "running";
}

export interface WorkflowRunResult {
	status: "running" | "completed" | "failed" | "cancelled";
	results?: Record<string, StepResult>;
	error?: string;
	failedStep?: string;
}

export interface ActiveActorAddress {
	ref: string;
	key: string;
}

export type StepActorHandle = {
	getOrCreate: (key: string) => {
		execute: (
			ctx: ExecuteContext,
			config?: unknown,
			wfId?: string,
			stepName?: string,
			coordinatorRef?: string,
			coordinatorKey?: string,
			coordinatorToken?: number,
		) => Promise<StepExecutionKickoffResult>;
		cancel: () => Promise<void>;
	};
};

export type LoopActorHandle = {
	getOrCreate: (key: string) => {
		runLoop: (
			selfKey: string,
			workflowId: string,
			input: unknown,
			parentStepResults: Record<string, StepResult>,
			parentLoopContext: LoopContext | undefined,
			loopKeyPrefix: string,
			parentRef: string,
			parentKey: string,
			parentCallbackName: string,
			parentToken: number,
		) => Promise<RunningKickoffResult>;
		cancel: () => Promise<void>;
	};
};

export type ParallelActorHandle = {
	getOrCreate: (key: string) => {
		runParallel: (
			selfKey: string,
			workflowId: string,
			input: unknown,
			parentStepResults: Record<string, StepResult>,
			parentLoopContext: LoopContext | undefined,
			parentRef?: string,
			parentKey?: string,
			parentCallbackName?: string,
			parentToken?: number,
		) => Promise<RunningKickoffResult>;
		cancel: () => Promise<void>;
	};
};

export type WorkflowActorHandle = {
	getOrCreate: (key: string) => {
		run: (
			workflowId: string,
			rawInput: unknown,
			initialStepResults?: Record<string, StepResult>,
			parentRef?: string,
			parentKey?: string,
			parentCallbackName?: string,
			parentToken?: number,
			parentLoopContext?: LoopContext,
		) => Promise<WorkflowRunResult>;
		cancel: () => Promise<void>;
	};
};

export function getStepActorHandle(
	client: Record<string, unknown>,
	actorRef: string,
): StepActorHandle | undefined {
	return client[actorRef] as StepActorHandle | undefined;
}

export function getLoopActorHandle(
	client: Record<string, unknown>,
	actorRef: string,
): LoopActorHandle | undefined {
	return client[actorRef] as LoopActorHandle | undefined;
}

export function getParallelActorHandle(
	client: Record<string, unknown>,
	actorRef: string,
): ParallelActorHandle | undefined {
	return client[actorRef] as ParallelActorHandle | undefined;
}

export function getWorkflowActorHandle(
	client: Record<string, unknown>,
	actorRef: string,
): WorkflowActorHandle | undefined {
	return client[actorRef] as WorkflowActorHandle | undefined;
}
