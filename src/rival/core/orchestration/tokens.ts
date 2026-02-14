export function nextExecutionToken(current: number | undefined): number {
	return Number.isFinite(current) ? (current as number) + 1 : 1;
}
