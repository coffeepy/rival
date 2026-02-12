import { describe, expect, test } from "bun:test";
import { type StepContext, compileWorkflow, createWorkflow } from "../src/rival";

function noopStep(_context: StepContext) {
	return { ok: true };
}

describe("timeout + actor options", () => {
	test("builder stores per-step actor options escape hatch", () => {
		const workflow = createWorkflow("actorOptionsBuilder")
			.step({
				fn: noopStep,
				name: "one",
				timeout: 250,
				actor: {
					options: {
						noSleep: true,
						actionTimeout: 50,
					},
				},
			})
			.build();

		const step = workflow.steps[0];
		if (!step || step.name !== "one" || !("config" in step)) {
			throw new Error("Expected first step with config");
		}
		expect(step.config?.actor?.options?.noSleep).toBe(true);
		expect(step.config?.timeout).toBe(250);
	});

	test("compile rejects invalid timeout values", () => {
		const workflow = createWorkflow("invalidTimeout")
			.step({
				fn: noopStep,
				name: "one",
				timeout: 0,
			})
			.build();

		expect(() => compileWorkflow(workflow)).toThrow(/invalid timeout/i);
	});

	test("compile rejects invalid actor action timeout when timeout is not set", () => {
		const workflow = createWorkflow("invalidActorTimeout")
			.step({
				fn: noopStep,
				name: "one",
				actor: {
					options: {
						actionTimeout: 0,
					},
				},
			})
			.build();

		expect(() => compileWorkflow(workflow)).toThrow(/actor\.options\.actionTimeout/i);
	});

	test("compile accepts actor options and timeout together (timeout controls action timeout)", () => {
		const workflow = createWorkflow("timeoutOverridesActorTimeout")
			.step({
				fn: noopStep,
				name: "one",
				timeout: 100,
				actor: {
					options: {
						actionTimeout: 1,
						noSleep: true,
					},
				},
			})
			.build();

		expect(() => compileWorkflow(workflow)).not.toThrow();
	});
});
