import type { LoopContext, StepResult } from "../types";
import type { ExecuteContext, StepExecutionKickoffResult } from "./step-actor";

/**
 * Opaque wrapper around the raw rivetkit client.
 * All actor lookups go through typed getXxxActorHandle() functions.
 * This is the ONLY file that performs `as` casts on the client.
 */
export type RivalClient = {
	readonly __brand: "RivalClient";
	readonly _raw: Record<string, unknown>;
};

/**
 * Convert c.client() to a RivalClient. Single cast boundary.
 * Call this instead of `c.client() as Record<string, unknown>` everywhere.
 *
 * Usage: `const rivalClient = getRivalClient(c.client());`
 */
export function getRivalClient(rawClient: unknown): RivalClient {
	return {
		__brand: "RivalClient" as const,
		_raw: rawClient as Record<string, unknown>,
	};
}

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

export type CoordinatorCallbackHandle = {
	getOrCreate: (key: string) => {
		onStepFinished?: (...args: unknown[]) => Promise<void>;
		onLoopFinished?: (...args: unknown[]) => Promise<void>;
		onParallelFinished?: (...args: unknown[]) => Promise<void>;
		onWorkflowFinished?: (...args: unknown[]) => Promise<void>;
	};
};

export function getStepActorHandle(
	client: RivalClient,
	actorRef: string,
): StepActorHandle | undefined {
	return client._raw[actorRef] as StepActorHandle | undefined;
}

export function getLoopActorHandle(
	client: RivalClient,
	actorRef: string,
): LoopActorHandle | undefined {
	return client._raw[actorRef] as LoopActorHandle | undefined;
}

export function getParallelActorHandle(
	client: RivalClient,
	actorRef: string,
): ParallelActorHandle | undefined {
	return client._raw[actorRef] as ParallelActorHandle | undefined;
}

export function getWorkflowActorHandle(
	client: RivalClient,
	actorRef: string,
): WorkflowActorHandle | undefined {
	return client._raw[actorRef] as WorkflowActorHandle | undefined;
}

export function getCoordinatorCallbackHandle(
	client: RivalClient,
	ref: string,
): CoordinatorCallbackHandle | undefined {
	return client._raw[ref] as CoordinatorCallbackHandle | undefined;
}
