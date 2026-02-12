export async function waitForTerminal<TStepResults extends Record<string, unknown>>(
	instance: {
		getState: () => Promise<{
			status: string;
			stepResults: TStepResults;
			error: string | null;
			failedStep?: string | null;
		}>;
	},
	pollIntervalMs = 25,
): Promise<{
	status: string;
	results?: TStepResults;
	error?: string;
	failedStep?: string;
}> {
	for (;;) {
		const state = await instance.getState();
		if (state.status === "completed") {
			return { status: "completed", results: state.stepResults };
		}
		if (state.status === "failed") {
			return {
				status: "failed",
				error: state.error ?? undefined,
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
