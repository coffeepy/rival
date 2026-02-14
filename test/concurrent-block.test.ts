import { describe, expect, test } from "bun:test";
import { type WorkflowDefinition, compileWorkflow, createWorkflow, rival } from "../src/rival";

describe("concurrent blocks", () => {
	test("compile emits parallel plan node with coordinator ref", () => {
		const wf = createWorkflow("concurrentCompile")
			.concurrent({
				alias: "setup",
				steps: [
					{ alias: "a", run: () => ({ ok: "a" }) },
					{ alias: "b", run: () => ({ ok: "b" }) },
				],
			})
			.build();

		const concurrent = wf.steps[0];
		expect(concurrent).toBeDefined();
		if (!concurrent || !("type" in concurrent) || concurrent.type !== "concurrent") {
			throw new Error("Expected first node to be concurrent");
		}
		expect(concurrent.continueOn).toBe("all");
		expect(concurrent.onFailure).toBe("fail");
	});

	test("concurrent child aliases are local to the block", () => {
		function fetchData() {
			return { ok: true };
		}

		const wf = createWorkflow("concurrentAliasScope")
			.step(fetchData)
			.concurrent({
				alias: "setup",
				steps: [fetchData],
			})
			.build();

		const concurrent = wf.steps[1];
		if (!concurrent || !("type" in concurrent) || concurrent.type !== "concurrent") {
			throw new Error("Expected second node to be concurrent");
		}
		expect(concurrent.steps[0]?.alias).toBe("fetchData");
	});

	test("compiler rejects duplicate concurrent child aliases in raw definitions", () => {
		const raw: WorkflowDefinition = {
			name: "rawConcurrentDuplicateAlias",
			steps: [
				{
					type: "concurrent",
					id: "p1",
					alias: "setup",
					steps: [
						{ id: "s1", alias: "dup", run: () => 1 },
						{ id: "s2", alias: "dup", run: () => 2 },
					],
				},
			],
		};

		expect(() => compileWorkflow(raw)).toThrow(/duplicate concurrent child alias/i);
	});

	test("rejects config on concurrent workflow child", () => {
		const nested = createWorkflow("nestedCfg")
			.step(() => "ok")
			.build();
		expect(() =>
			createWorkflow("concurrentWorkflowConfig")
				.concurrent({
					alias: "setup",
					steps: [{ alias: "child", run: nested, timeout: 1000 }],
				})
				.build(),
		).toThrow(/step-only config/i);
	});

	test("runs concurrent steps and returns keyed map", async () => {
		const wf = createWorkflow("concurrentRunSuccess")
			.step({ alias: "seed", run: () => 2 })
			.concurrent({
				alias: "setup",
				steps: [
					{
						alias: "double",
						run: ({ steps }) => ((steps.seed?.result as number) ?? 0) * 2,
					},
					{
						alias: "triple",
						run: ({ steps }) => ((steps.seed?.result as number) ?? 0) * 3,
					},
				],
			})
			.step({
				alias: "sum",
				run: ({ steps }) => {
					const setup = steps.setup?.result as Record<
						string,
						{ status: string; result: number; state: Record<string, unknown> }
					>;
					return (setup.double?.result ?? 0) + (setup.triple?.result ?? 0);
				},
			})
			.build();

		const engine = rival(wf);
		const start = await engine.run("concurrentRunSuccess", {});
		const result = await engine.wait("concurrentRunSuccess", start.runId);
		expect(result.status).toBe("completed");
		expect(result.results?.sum?.result).toBe(10);
		const setup = result.results?.setup?.result as Record<
			string,
			{ status: string; result: number }
		>;
		expect(setup.double?.status).toBe("completed");
		expect(setup.double?.result).toBe(4);
		expect(setup.triple?.result).toBe(6);
	});

	test("onFailure=collect completes while preserving failed child statuses", async () => {
		const wf = createWorkflow("concurrentCollect")
			.concurrent({
				alias: "group",
				onFailure: "collect",
				steps: [
					{ alias: "ok", run: () => "ok" },
					{
						alias: "bad",
						run: () => {
							throw new Error("boom");
						},
					},
				],
			})
			.step({
				alias: "after",
				run: ({ steps }) => {
					const group = steps.group?.result as Record<string, { status: string }>;
					return `${group.ok?.status}:${group.bad?.status}`;
				},
			})
			.build();

		const engine = rival(wf);
		const start = await engine.run("concurrentCollect", {});
		const result = await engine.wait("concurrentCollect", start.runId);
		expect(result.status).toBe("completed");
		expect(result.results?.after?.result).toBe("completed:failed");
	});

	test("supports concurrent inside forEach workflow body", async () => {
		const body = createWorkflow("concurrentBody")
			.concurrent({
				alias: "pair",
				steps: [
					{
						alias: "double",
						run: ({ loop }) => ((loop?.item as number) ?? 0) * 2,
					},
					{
						alias: "triple",
						run: ({ loop }) => ((loop?.item as number) ?? 0) * 3,
					},
				],
			})
			.step({
				alias: "sum",
				run: ({ steps }) => {
					const pair = steps.pair?.result as Record<string, { result: number }>;
					return (pair.double?.result ?? 0) + (pair.triple?.result ?? 0);
				},
			})
			.build();

		const wf = createWorkflow("concurrentInLoop")
			.forEach({
				alias: "items",
				items: () => [1, 2],
				run: body,
				parallel: true,
			})
			.build();

		const engine = rival(wf);
		const start = await engine.run("concurrentInLoop", {});
		const result = await engine.wait("concurrentInLoop", start.runId);
		expect(result.status).toBe("completed");

		const loopResult = result.results?.items?.result as {
			iterations: Array<{
				index: number;
				results: Record<string, { status: string; result: unknown }>;
			}>;
		};
		expect(loopResult.iterations).toHaveLength(2);
		expect(loopResult.iterations[0]?.results.pair?.status).toBe("completed");
		expect(loopResult.iterations[1]?.results.pair?.status).toBe("completed");
	});

	test("preserves outer loop context through nested workflow concurrent dispatch", async () => {
		const inner = createWorkflow("innerCtx")
			.concurrent({
				alias: "group",
				steps: [{ alias: "readLoop", run: ({ loop }) => loop?.item }],
			})
			.step({
				alias: "pluck",
				run: ({ steps }) =>
					(steps.group?.result as Record<string, { result: unknown }>).readLoop?.result,
			})
			.build();

		const body = createWorkflow("bodyCtx")
			.concurrent({
				alias: "branch",
				steps: [{ alias: "wf", run: inner }],
			})
			.step({
				alias: "result",
				run: ({ steps }) => {
					const branch = steps.branch?.result as Record<
						string,
						{ result: Record<string, { result: unknown }> }
					>;
					return branch.wf?.result?.pluck?.result;
				},
			})
			.build();

		const wf = createWorkflow("loopCtxPropagation")
			.forEach({
				alias: "items",
				items: () => [7],
				run: body,
			})
			.build();

		const engine = rival(wf);
		const start = await engine.run("loopCtxPropagation", {});
		const result = await engine.wait("loopCtxPropagation", start.runId);
		expect(result.status).toBe("completed");

		const loopResult = result.results?.items?.result as {
			iterations: Array<{ results: Record<string, { result: unknown }> }>;
		};
		expect(loopResult.iterations[0]?.results.result?.result).toBe(7);
	});

	test("continueOn=detached advances without waiting for concurrent children", async () => {
		let finished = 0;

		const wf = createWorkflow("concurrentDetached")
			.concurrent({
				alias: "bg",
				continueOn: "detached",
				steps: [
					{
						alias: "slow",
						run: async () => {
							await new Promise((resolve) => setTimeout(resolve, 100));
							finished += 1;
							return "done";
						},
					},
				],
			})
			.step({
				alias: "after",
				run: ({ lastStep }) => ({
					finished,
					lastAlias: lastStep.alias,
					detached: Boolean((lastStep.state as { detached?: boolean } | undefined)?.detached),
				}),
			})
			.build();

		const engine = rival(wf);
		const start = await engine.run("concurrentDetached", {});
		const result = await engine.wait("concurrentDetached", start.runId);
		expect(result.status).toBe("completed");
		expect(result.results?.after?.result).toEqual({
			finished: 0,
			lastAlias: "bg",
			detached: true,
		});
		expect(result.results?.bg?.status).toBe("completed");
		expect(result.results?.bg?.state).toEqual({ detached: true });
	});

	test("hard failure finalizes even when steps remain undispatched", async () => {
		const steps = Array.from({ length: 30 }, (_value, index) => {
			if (index === 0) {
				return {
					alias: "boom",
					run: () => {
						throw new Error("boom");
					},
				};
			}
			return {
				alias: `s${index}`,
				run: async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return index;
				},
			};
		});

		const wf = createWorkflow("concurrentHardFailureUndispatched")
			.concurrent({
				alias: "group",
				steps,
			})
			.build();

		const engine = rival(wf);
		const start = await engine.run("concurrentHardFailureUndispatched", {});
		const result = await Promise.race([
			engine.wait("concurrentHardFailureUndispatched", start.runId),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("timeout waiting for failure")), 2000),
			),
		]);
		expect((result as { status: string }).status).toBe("failed");
	});
});
