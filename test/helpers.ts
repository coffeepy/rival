/**
 * Test Helpers
 *
 * Shared utilities for polling-based test patterns.
 */

/**
 * Polls an actor's getState() until the status reaches one of the target values.
 *
 * Rival workflows are intentionally async and schedule-driven, so tests should
 * not assume "start/launch" means "already finished". This helper models the
 * same polling pattern that a UI or API layer would use in production.
 *
 * @param actor - Any object with a getState() method returning { status: string }
 * @param targets - Status values to wait for (default: terminal states)
 * @param timeoutMs - Maximum time to wait before throwing
 * @param pollMs - Interval between polls
 * @returns The final state once a target status is reached
 */
export async function waitForStatus<T extends { status: string; [key: string]: unknown }>(
	actor: { getState: () => Promise<T> },
	targets: string[] = ["completed", "failed", "cancelled"],
	timeoutMs = 5000,
	pollMs = 50,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const state = await actor.getState();
		if (targets.includes(state.status)) {
			return state;
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}

	// One final check before throwing
	const finalState = await actor.getState();
	if (targets.includes(finalState.status)) {
		return finalState;
	}

	throw new Error(
		`Timed out after ${timeoutMs}ms waiting for status [${targets.join(", ")}], ` +
			`last status: "${finalState.status}"`,
	);
}
