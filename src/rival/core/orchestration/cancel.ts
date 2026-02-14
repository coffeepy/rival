import type {
	LoopActorHandle,
	ParallelActorHandle,
	RivalClient,
	StepActorHandle,
	WorkflowActorHandle,
} from "../actor-handles";

export interface CancelTarget {
	ref: string;
	key: string;
}

interface CancelPropagationOptions<THandle> {
	client: RivalClient;
	targets: CancelTarget[];
	getHandle: (client: RivalClient, ref: string) => THandle | undefined;
	cancelActor: (handle: THandle, key: string) => Promise<void>;
	onError: (target: CancelTarget, err: unknown) => void;
}

async function propagateCancel<THandle>(options: CancelPropagationOptions<THandle>): Promise<void> {
	for (const target of options.targets) {
		try {
			const handle = options.getHandle(options.client, target.ref);
			if (handle) await options.cancelActor(handle, target.key);
		} catch (err) {
			options.onError(target, err);
		}
	}
}

export async function propagateStepCancel(
	client: RivalClient,
	targets: CancelTarget[],
	getHandle: (client: RivalClient, ref: string) => StepActorHandle | undefined,
	onError: (target: CancelTarget, err: unknown) => void,
): Promise<void> {
	await propagateCancel({
		client,
		targets,
		getHandle,
		cancelActor: (handle, key) => handle.getOrCreate(key).cancel(),
		onError,
	});
}

export async function propagateLoopCancel(
	client: RivalClient,
	targets: CancelTarget[],
	getHandle: (client: RivalClient, ref: string) => LoopActorHandle | undefined,
	onError: (target: CancelTarget, err: unknown) => void,
): Promise<void> {
	await propagateCancel({
		client,
		targets,
		getHandle,
		cancelActor: (handle, key) => handle.getOrCreate(key).cancel(),
		onError,
	});
}

export async function propagateParallelCancel(
	client: RivalClient,
	targets: CancelTarget[],
	getHandle: (client: RivalClient, ref: string) => ParallelActorHandle | undefined,
	onError: (target: CancelTarget, err: unknown) => void,
): Promise<void> {
	await propagateCancel({
		client,
		targets,
		getHandle,
		cancelActor: (handle, key) => handle.getOrCreate(key).cancel(),
		onError,
	});
}

export async function propagateWorkflowCancel(
	client: RivalClient,
	targets: CancelTarget[],
	getHandle: (client: RivalClient, ref: string) => WorkflowActorHandle | undefined,
	onError: (target: CancelTarget, err: unknown) => void,
): Promise<void> {
	await propagateCancel({
		client,
		targets,
		getHandle,
		cancelActor: (handle, key) => handle.getOrCreate(key).cancel(),
		onError,
	});
}
