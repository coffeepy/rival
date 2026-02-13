export function validateForEachConcurrency(
	workflowName: string,
	loopAlias: string,
	config: { concurrency?: number; parallel?: boolean },
): void {
	if (config.concurrency === undefined) return;

	if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
		throw new Error(
			`Workflow "${workflowName}" loop "${loopAlias}" has invalid concurrency ${String(config.concurrency)}. concurrency must be an integer >= 1.`,
		);
	}
	if (!config.parallel) {
		throw new Error(
			`Workflow "${workflowName}" loop "${loopAlias}" sets concurrency but parallel is not true.`,
		);
	}
}
