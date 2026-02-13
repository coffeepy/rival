import { describe, expect, jest, test } from "bun:test";
import { createMemoryDriver, setup } from "rivetkit";
import { type StepContext, StepError, createStepActor } from "../src/rival";

function emptyContext(): Omit<StepContext, "log" | "state"> {
	return {
		input: {},
		steps: {},
		lastStep: {
			result: undefined,
			state: {},
			alias: null,
		},
	};
}

async function flushTimers(ms = 0): Promise<void> {
	jest.advanceTimersByTime(ms);
	// Allow promise continuations scheduled by timer callbacks to settle.
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

describe("Step actor scheduled retries", () => {
	test("transitions through waiting_retry and eventually completes", async () => {
		jest.useFakeTimers();
		let attempts = 0;
		const flakyActor = createStepActor(({ state }: StepContext) => {
			attempts += 1;
			if (attempts < 3) {
				throw new Error(`attempt ${attempts} failed`);
			}
			state.description = "done";
			return { ok: true };
		});

		const registry = setup({ use: { flakyActor } });
		const { client } = registry.start({
			disableDefaultServer: true,
			noWelcome: true,
			driver: createMemoryDriver(),
		});
		const step = client.flakyActor.getOrCreate("wait-retry");

		try {
			const kickoff = await step.execute(emptyContext(), { maxAttempts: 3 });
			expect(kickoff.status).toBe("running");

			await flushTimers(0); // attempt 1
			let sawWaitingRetry = false;
			const state = await step.getState();
			if (state.status === "waiting_retry") {
				sawWaitingRetry = true;
			}
			await flushTimers(100); // attempt 2
			await flushTimers(200); // attempt 3

			const terminal = await step.getTerminalResult();
			expect(sawWaitingRetry).toBeTrue();
			expect(terminal?.status).toBe("completed");
			expect(attempts).toBe(3);
		} finally {
			jest.useRealTimers();
		}
	});

	test("caps StepError retry maxAttempts by config maxAttempts", async () => {
		jest.useFakeTimers();
		let attempts = 0;
		const cappedActor = createStepActor(() => {
			attempts += 1;
			throw new StepError("retry me", {
				behavior: "retry",
				maxAttempts: 10,
				backoff: "linear",
			});
		});

		const registry = setup({ use: { cappedActor } });
		const { client } = registry.start({
			disableDefaultServer: true,
			noWelcome: true,
			driver: createMemoryDriver(),
		});
		const step = client.cappedActor.getOrCreate("capped-retries");

		try {
			await step.execute(emptyContext(), { maxAttempts: 2 });
			await flushTimers(0); // attempt 1
			await flushTimers(100); // attempt 2
			const terminal = await step.getTerminalResult();
			const state = await step.getState();

			expect(terminal?.status).toBe("failed");
			expect(state.attempts).toBe(2);
			expect(attempts).toBe(2);
		} finally {
			jest.useRealTimers();
		}
	});
});
