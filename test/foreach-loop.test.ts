/**
 * ForEach Loop Test
 *
 * Tests the forEach loop construct:
 * - Builder: forEach with single step function
 * - Builder: forEach with workflow definition
 * - Builder: duplicate forEach name rejected
 * - Builder: forEach name colliding with step name rejected
 * - Compiler: correct actors and plan produced
 * - Execution: sequential forEach
 * - Execution: parallel forEach
 * - Execution: loop context accessible in body steps
 * - Execution: body steps see prior body-step outputs
 * - Execution: steps before/after forEach access loop results
 * - Execution: lastStep after loop references loop name
 * - Execution: hard failure stops sequential loop
 * - Execution: continueOnError in sequential loop
 * - Execution: hard failure in parallel loop fails workflow
 * - Execution: continueOnError in parallel loop completes
 * - Execution: nested forEach recursion
 * - Execution: nested forEach with outer parallel
 * - Execution: nested forEach with inner parallel
 * - Execution: nested forEach hard failure propagation (sequential outer)
 * - Execution: nested forEach hard failure propagation (parallel outer)
 * - Execution: nested forEach continueOnError in inner loop
 * - Execution: retry behavior in sequential forEach
 * - Execution: retry behavior in parallel forEach
 * - Execution: retry behavior in nested forEach
 * - Execution: retry exhaustion in nested forEach fails workflow
 * - Execution: empty items array
 * - Execution: via Engine rival() API
 * - Execution: iterator returning non-array fails
 *
 * Run with: bun test/foreach-loop.test.ts
 */

import { type StepContext, StepError, compileWorkflow, createWorkflow, rival } from "../src/rival";

// =============================================================================
// HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`  FAIL: ${message}`);
		failed++;
	} else {
		console.log(`  ok: ${message}`);
		passed++;
	}
}

async function runToTerminal(
	engine: ReturnType<typeof rival>,
	workflowName: string,
	input?: unknown,
	runId?: string,
) {
	const start = await engine.run(workflowName, input, runId);
	assert(!!start.runId, "run() returns runId");
	return engine.wait(workflowName, start.runId);
}

// =============================================================================
// STEP FUNCTIONS
// =============================================================================

function getItems({ input }: StepContext) {
	return (input as { items: unknown[] }).items;
}

function processItem({ loop }: StepContext) {
	return { processed: loop?.item, index: loop?.index };
}

function doubleItem({ loop }: StepContext) {
	const num = loop?.item as number;
	return { doubled: num * 2 };
}

function validateItem({ loop, log }: StepContext) {
	const item = loop?.item as { name: string; price: number };
	log.info(`Validating ${item.name}`);
	return { valid: true, name: item.name };
}

function chargeItem({ loop, steps }: StepContext) {
	const item = loop?.item as { name: string; price: number };
	const validation = steps.validateItem?.result as { valid: boolean } | undefined;
	return { charged: validation?.valid ? item.price : 0, name: item.name };
}

function beforeLoop({ input }: StepContext) {
	return { prefix: (input as { prefix: string }).prefix };
}

function afterLoop({ steps }: StepContext) {
	const loopResult = steps.processEach?.result as { iterations: unknown[] };
	return { totalIterations: loopResult.iterations.length };
}

function afterMarker() {
	return { ran: true };
}

function failingItem({ loop }: StepContext) {
	const item = loop?.item as { shouldFail?: boolean; value?: number };
	if (item.shouldFail) {
		throw new Error(`Item ${loop?.index} failed`);
	}
	return { value: item.value };
}

function softFailItem({ loop }: StepContext) {
	const item = loop?.item as { shouldFail?: boolean; value?: number };
	if (item.shouldFail) {
		throw new StepError(`Item ${loop?.index} soft-failed`, { behavior: "continue" });
	}
	return { value: item.value };
}

function returnNonArray() {
	return "not-an-array";
}

function getGroups({ input }: StepContext) {
	return (input as { groups: Array<{ numbers: number[] }> }).groups;
}

function getGroupNumbers({ loop }: StepContext) {
	const group = loop?.item as { numbers: number[] };
	return group.numbers;
}

function getGroupRetryItems({ loop }: StepContext) {
	const group = loop?.item as {
		retryItems: Array<{ id: string; failUntil?: number }>;
	};
	return group.retryItems;
}

function squareNumber({ loop }: StepContext) {
	const num = loop?.item as number;
	return { squared: num * num };
}

function squareOrFailOnThree({ loop }: StepContext) {
	const num = loop?.item as number;
	if (num === 3) {
		throw new Error("Number 3 failed");
	}
	return { squared: num * num };
}

function squareOrSoftFailOnThree({ loop }: StepContext) {
	const num = loop?.item as number;
	if (num === 3) {
		throw new StepError("Number 3 soft-failed", { behavior: "continue" });
	}
	return { squared: num * num };
}

async function slowProcessItem({ loop }: StepContext) {
	await new Promise((resolve) => setTimeout(resolve, 50));
	return { processed: loop?.item, index: loop?.index };
}

const retryAttemptsById = new Map<string, number>();

function resetRetryAttempts() {
	retryAttemptsById.clear();
}

function retryByItemId({ loop }: StepContext) {
	const item = loop?.item as { id: string; failUntil?: number };
	const id = item.id;
	const nextAttempt = (retryAttemptsById.get(id) ?? 0) + 1;
	retryAttemptsById.set(id, nextAttempt);

	if (nextAttempt <= (item.failUntil ?? 2)) {
		throw new Error(`Item ${id} failed attempt ${nextAttempt}`);
	}
	return { id, attempt: nextAttempt };
}

// =============================================================================
// TEST: BUILDER — forEach with single step function
// =============================================================================

async function testBuilderSingleStep() {
	console.log("\n--- TEST: Builder — forEach with single step function ---\n");

	const workflow = createWorkflow("singleStep")
		.forEach("processEach", {
			items: getItems,
			do: processItem,
		})
		.build();

	assert(workflow.name === "singleStep", "workflow name");
	assert(workflow.steps.length === 1, "one entry in steps");
	const entry = workflow.steps[0];
	assert("type" in entry && entry.type === "forEach", "entry is forEach");
	assert(entry.name === "processEach", "forEach name");
}

// =============================================================================
// TEST: BUILDER — forEach with workflow definition
// =============================================================================

async function testBuilderWorkflowDo() {
	console.log("\n--- TEST: Builder — forEach with workflow definition ---\n");

	const orderFlow = createWorkflow("orderFlow").step(validateItem).step(chargeItem).build();

	const workflow = createWorkflow("batchProcess")
		.forEach("processAll", {
			items: getItems,
			do: orderFlow,
			parallel: true,
		})
		.build();

	assert(workflow.name === "batchProcess", "workflow name");
	assert(workflow.steps.length === 1, "one entry");
	const entry = workflow.steps[0];
	assert("type" in entry && entry.type === "forEach", "entry is forEach");
	assert((entry as { parallel?: boolean }).parallel === true, "parallel flag set");
}

// =============================================================================
// TEST: BUILDER — concurrency validation
// =============================================================================

async function testBuilderConcurrencyValidation() {
	console.log("\n--- TEST: Builder — concurrency validation ---\n");

	try {
		createWorkflow("badConcurrencyZero")
			.forEach("loop", {
				items: getItems,
				do: processItem,
				parallel: true,
				concurrency: 0,
			})
			.build();
		assert(false, "concurrency 0 should throw");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("concurrency"), "error mentions concurrency");
	}

	try {
		createWorkflow("badConcurrencyNoParallel")
			.forEach("loop", {
				items: getItems,
				do: processItem,
				concurrency: 2,
			})
			.build();
		assert(false, "concurrency without parallel should throw");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("parallel"), "error mentions parallel");
	}
}

// =============================================================================
// TEST: BUILDER — duplicate forEach name rejected
// =============================================================================

async function testBuilderDuplicateForEachName() {
	console.log("\n--- TEST: Builder — duplicate forEach name rejected ---\n");

	try {
		createWorkflow("dupLoop")
			.forEach("loop1", { items: getItems, do: processItem })
			.forEach("loop1", { items: getItems, do: processItem })
			.build();
		assert(false, "should have thrown");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("loop1"), "error mentions duplicate name");
		assert(msg.includes("unique"), "error says must be unique");
	}
}

// =============================================================================
// TEST: BUILDER — forEach name colliding with step name rejected
// =============================================================================

async function testBuilderNameCollision() {
	console.log("\n--- TEST: Builder — forEach/step name collision rejected ---\n");

	try {
		createWorkflow("collision")
			.step(function myStep() {
				return {};
			})
			.forEach("myStep", { items: getItems, do: processItem })
			.build();
		assert(false, "should have thrown");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("myStep"), "error mentions colliding name");
	}
}

// =============================================================================
// TEST: COMPILER — correct actors and plan produced
// =============================================================================

async function testCompiler() {
	console.log("\n--- TEST: Compiler — correct actors and plan ---\n");

	const workflow = createWorkflow("compilerTest")
		.step(function prepare() {
			return {};
		})
		.forEach("processEach", {
			items: getItems,
			do: processItem,
		})
		.build();

	const compiled = compileWorkflow(workflow);

	// Should have: prepare step actor, iterator actor, do actor, coordinator
	const actorNames = Object.keys(compiled.actors);
	console.log(`  Actors: ${actorNames.join(", ")}`);

	assert(actorNames.includes("compilerTest_prepare"), "has prepare actor");
	assert(
		actorNames.includes("compilerTest__loop__processEach__iterator"),
		"has iterator actor with __loop__ namespace",
	);
	assert(
		actorNames.includes("compilerTest__loop__processEach__do__processItem"),
		"has do actor with __loop__do__ namespace",
	);
	assert(actorNames.includes("compilerTest_coordinator"), "has coordinator actor");

	// Check plan structure
	assert(compiled.plan.length === 2, "plan has 2 nodes");
	assert(compiled.plan[0].type === "step", "first node is step");
	assert(compiled.plan[1].type === "loop", "second node is loop");

	if (compiled.plan[1].type === "loop") {
		const loopNode = compiled.plan[1];
		assert(loopNode.name === "processEach", "loop node name");
		assert(
			loopNode.iteratorActorRef === "compilerTest__loop__processEach__iterator",
			"iterator actor ref",
		);
		assert(loopNode.do.length === 1, "loop do has 1 node");
		assert(loopNode.do[0].type === "step", "do node is step");
	}
}

// =============================================================================
// TEST: COMPILER — workflow definition as do
// =============================================================================

async function testCompilerWorkflowDo() {
	console.log("\n--- TEST: Compiler — workflow definition as do ---\n");

	const bodyFlow = createWorkflow("bodyFlow").step(validateItem).step(chargeItem).build();

	const workflow = createWorkflow("compilerWfDo")
		.forEach("processAll", {
			items: getItems,
			do: bodyFlow,
			parallel: true,
		})
		.build();

	const compiled = compileWorkflow(workflow);
	const actorNames = Object.keys(compiled.actors);

	assert(
		actorNames.includes("compilerWfDo__loop__processAll__do__validateItem"),
		"has validateItem do actor",
	);
	assert(
		actorNames.includes("compilerWfDo__loop__processAll__do__chargeItem"),
		"has chargeItem do actor",
	);

	if (compiled.plan[0].type === "loop") {
		assert(compiled.plan[0].do.length === 2, "loop do has 2 nodes");
		assert(compiled.plan[0].parallel === true, "parallel flag");
	}
}

// =============================================================================
// TEST: COMPILER — loop coordinator ref + concurrency
// =============================================================================

async function testCompilerLoopCoordinatorAndConcurrency() {
	console.log("\n--- TEST: Compiler — loop coordinator ref + concurrency ---\n");

	const workflow = createWorkflow("compilerConcurrency")
		.forEach("processAll", {
			items: getItems,
			do: processItem,
			parallel: true,
			concurrency: 2,
		})
		.build();

	const compiled = compileWorkflow(workflow);
	const loopNode = compiled.plan[0];
	assert(loopNode?.type === "loop", "plan node is loop");
	if (!loopNode || loopNode.type !== "loop") return;

	assert(
		loopNode.loopCoordinatorActorRef === "compilerConcurrency__loop__processAll__coordinator",
		"loop node has loop coordinator actor ref",
	);
	assert(loopNode.concurrency === 2, "loop node has concurrency");
	assert(
		Object.hasOwn(compiled.actors, loopNode.loopCoordinatorActorRef),
		"loop coordinator actor is registered",
	);
}

// =============================================================================
// TEST: EXECUTION — sequential forEach
// =============================================================================

async function testSequentialExecution() {
	console.log("\n--- TEST: Execution — sequential forEach ---\n");

	const workflow = createWorkflow("seqForEach")
		.forEach("processEach", {
			items: getItems,
			do: doubleItem,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "seqForEach", { items: [1, 2, 3] });

	assert(result.status === "completed", "workflow completed");

	const loopResult = result.results?.processEach;
	assert(loopResult !== undefined, "loop result exists");
	assert(loopResult?.status === "completed", "loop completed");

	const iterations = (
		loopResult?.result as {
			iterations: Array<{
				item: number;
				index: number;
				results: Record<string, { result: { doubled: number } }>;
			}>;
		}
	).iterations;
	assert(iterations.length === 3, "3 iterations");
	assert(iterations[0].item === 1, "first item is 1");
	assert(iterations[0].index === 0, "first index is 0");
	assert(iterations[0].results.doubleItem.result.doubled === 2, "1 doubled is 2");
	assert(iterations[1].results.doubleItem.result.doubled === 4, "2 doubled is 4");
	assert(iterations[2].results.doubleItem.result.doubled === 6, "3 doubled is 6");
}

// =============================================================================
// TEST: EXECUTION — parallel forEach
// =============================================================================

async function testParallelExecution() {
	console.log("\n--- TEST: Execution — parallel forEach ---\n");

	const workflow = createWorkflow("parForEach")
		.forEach("processEach", {
			items: getItems,
			do: doubleItem,
			parallel: true,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "parForEach", { items: [10, 20, 30] });

	assert(result.status === "completed", "workflow completed");

	const iterations = (
		result.results?.processEach.result as {
			iterations: Array<{
				item: number;
				index: number;
				results: Record<string, { result: { doubled: number } }>;
			}>;
		}
	).iterations;
	assert(iterations.length === 3, "3 iterations");

	// Results should be in order (sorted by index)
	assert(iterations[0].index === 0, "first index 0");
	assert(iterations[1].index === 1, "second index 1");
	assert(iterations[2].index === 2, "third index 2");

	assert(iterations[0].results.doubleItem.result.doubled === 20, "10 doubled is 20");
	assert(iterations[1].results.doubleItem.result.doubled === 40, "20 doubled is 40");
	assert(iterations[2].results.doubleItem.result.doubled === 60, "30 doubled is 60");
}

// =============================================================================
// TEST: EXECUTION — loop context accessible
// =============================================================================

async function testLoopContext() {
	console.log("\n--- TEST: Execution — loop context accessible ---\n");

	function checkContext({ loop }: StepContext) {
		return {
			hasItem: loop?.item !== undefined,
			index: loop?.index,
			totalItems: loop?.items.length,
		};
	}

	const workflow = createWorkflow("ctxCheck")
		.forEach("checkLoop", {
			items: getItems,
			do: checkContext,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "ctxCheck", { items: ["a", "b"] });

	assert(result.status === "completed", "workflow completed");

	const iterations = (
		result.results?.checkLoop.result as {
			iterations: Array<{
				results: Record<
					string,
					{ result: { hasItem: boolean; index: number; totalItems: number } }
				>;
			}>;
		}
	).iterations;

	assert(iterations[0].results.checkContext.result.hasItem === true, "has item");
	assert(iterations[0].results.checkContext.result.index === 0, "index 0");
	assert(iterations[0].results.checkContext.result.totalItems === 2, "totalItems 2");
	assert(iterations[1].results.checkContext.result.index === 1, "index 1");
}

// =============================================================================
// TEST: EXECUTION — body steps see prior body-step outputs
// =============================================================================

async function testBodyStepVisibility() {
	console.log("\n--- TEST: Execution — body steps see prior body-step outputs ---\n");

	const bodyFlow = createWorkflow("bodyVis").step(validateItem).step(chargeItem).build();

	const workflow = createWorkflow("bodyVisTest")
		.forEach("processAll", {
			items: getItems,
			do: bodyFlow,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "bodyVisTest", {
		items: [
			{ name: "Widget", price: 9.99 },
			{ name: "Gadget", price: 19.99 },
		],
	});

	assert(result.status === "completed", "workflow completed");

	const iterations = (
		result.results?.processAll.result as {
			iterations: Array<{ results: Record<string, { result: unknown }> }>;
		}
	).iterations;

	// chargeItem should have seen validateItem's result
	const charge0 = iterations[0].results.chargeItem.result as { charged: number; name: string };
	assert(charge0.charged === 9.99, "first item charged correctly");
	assert(charge0.name === "Widget", "first item name correct");

	const charge1 = iterations[1].results.chargeItem.result as { charged: number; name: string };
	assert(charge1.charged === 19.99, "second item charged correctly");
}

// =============================================================================
// TEST: EXECUTION — steps before/after forEach access loop results
// =============================================================================

async function testBeforeAfterLoop() {
	console.log("\n--- TEST: Execution — steps before/after forEach ---\n");

	const workflow = createWorkflow("beforeAfter")
		.step(beforeLoop)
		.forEach("processEach", {
			items: getItems,
			do: processItem,
		})
		.step(afterLoop)
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "beforeAfter", {
		prefix: "test",
		items: [1, 2, 3],
	});

	assert(result.status === "completed", "workflow completed");
	assert(
		(result.results?.beforeLoop.result as { prefix: string }).prefix === "test",
		"beforeLoop result accessible",
	);
	assert(
		(result.results?.afterLoop.result as { totalIterations: number }).totalIterations === 3,
		"afterLoop can access loop results",
	);
}

// =============================================================================
// TEST: EXECUTION — lastStep after loop references loop name
// =============================================================================

async function testLastStepAfterLoop() {
	console.log("\n--- TEST: Execution — lastStep after loop references loop name ---\n");

	function checkLastStep({ lastStep }: StepContext) {
		return {
			lastStepName: lastStep.stepName,
			lastStepHasIterations:
				lastStep.result !== undefined &&
				typeof lastStep.result === "object" &&
				lastStep.result !== null &&
				"iterations" in lastStep.result,
		};
	}

	const workflow = createWorkflow("lastStepCheck")
		.forEach("myLoop", {
			items: getItems,
			do: processItem,
		})
		.step(checkLastStep)
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "lastStepCheck", { items: [1] });

	assert(result.status === "completed", "workflow completed");

	const checkResult = result.results?.checkLastStep.result as {
		lastStepName: string;
		lastStepHasIterations: boolean;
	};
	assert(checkResult.lastStepName === "myLoop", "lastStep.stepName is loop name");
	assert(checkResult.lastStepHasIterations === true, "lastStep.result has iterations");
}

// =============================================================================
// TEST: EXECUTION — hard failure stops sequential loop
// =============================================================================

async function testHardFailureStopsLoop() {
	console.log("\n--- TEST: Execution — hard failure stops sequential loop ---\n");

	const workflow = createWorkflow("hardFail")
		.forEach("loopFail", {
			items: getItems,
			do: failingItem,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "hardFail", {
		items: [{ value: 1 }, { shouldFail: true }, { value: 3 }],
	});

	assert(result.status === "failed", "workflow failed due to loop hard failure");
	assert(result.failedStep === "loopFail", "failedStep is the loop name");

	const loopResult = result.results?.loopFail;
	assert(loopResult !== undefined, "loop result exists");
	if (!loopResult) return;
	assert(loopResult.status === "failed", "loop status is failed");

	const iterations = (loopResult.result as { iterations: Array<{ index: number }> }).iterations;
	// Should have 2 iterations (first succeeded, second failed, third never ran)
	assert(iterations.length === 2, "only 2 iterations ran before failure");
}

// =============================================================================
// TEST: EXECUTION — steps after failed loop do not run
// =============================================================================

async function testStepsAfterFailedLoopSkipped() {
	console.log("\n--- TEST: Execution — steps after failed loop do not run ---\n");

	const workflow = createWorkflow("afterFail")
		.forEach("loopFail", {
			items: getItems,
			do: failingItem,
		})
		.step(afterLoop)
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "afterFail", {
		items: [{ shouldFail: true }],
	});

	assert(result.status === "failed", "workflow failed");
	assert(result.failedStep === "loopFail", "failedStep is the loop");
	assert(result.results?.afterLoop === undefined, "afterLoop did not run");
}

// =============================================================================
// TEST: EXECUTION — continueOnError in sequential loop
// =============================================================================

async function testContinueOnError() {
	console.log("\n--- TEST: Execution — continueOnError in sequential loop ---\n");

	const workflow = createWorkflow("softFail")
		.forEach("loopSoft", {
			items: getItems,
			do: softFailItem,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "softFail", {
		items: [{ value: 1 }, { shouldFail: true }, { value: 3 }],
	});

	assert(result.status === "completed", "workflow completed");

	const loopResult = result.results?.loopSoft;
	assert(loopResult !== undefined, "loop result exists");
	if (!loopResult) return;
	assert(loopResult.status === "completed", "loop completed (soft failures handled)");

	const iterations = (
		loopResult.result as {
			iterations: Array<{ index: number; results: Record<string, { status: string }> }>;
		}
	).iterations;
	assert(iterations.length === 3, "all 3 iterations ran");
	assert(iterations[1].results.softFailItem.status === "failed", "second iteration step failed");
}

// =============================================================================
// TEST: EXECUTION — hard failure in parallel loop fails workflow
// =============================================================================

async function testParallelHardFailureFailsWorkflow() {
	console.log("\n--- TEST: Execution — hard failure in parallel loop fails workflow ---\n");

	const workflow = createWorkflow("parHardFail")
		.forEach("loopFailPar", {
			items: getItems,
			do: failingItem,
			parallel: true,
		})
		.step({ name: "afterMarker", fn: afterMarker })
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "parHardFail", {
		items: [{ value: 1 }, { shouldFail: true }, { value: 3 }],
	});

	assert(result.status === "failed", "workflow failed due to parallel loop hard failure");
	assert(result.failedStep === "loopFailPar", "failedStep is the parallel loop name");
	assert(result.results?.afterMarker === undefined, "step after failed loop did not run");

	const loopResult = result.results?.loopFailPar;
	assert(loopResult !== undefined, "loop result exists");
	if (!loopResult) return;
	assert(loopResult.status === "failed", "parallel loop status is failed");

	const iterations = (
		loopResult.result as {
			iterations: Array<{ results: Record<string, { status: string }> }>;
		}
	).iterations;
	assert(iterations.length === 3, "all parallel iterations settled");
	assert(
		iterations.some((it) => it.results.failingItem?.status === "failed"),
		"at least one iteration failed",
	);
}

// =============================================================================
// TEST: EXECUTION — continueOnError in parallel loop
// =============================================================================

async function testParallelContinueOnError() {
	console.log("\n--- TEST: Execution — continueOnError in parallel loop ---\n");

	const workflow = createWorkflow("parSoftFail")
		.forEach("loopSoftPar", {
			items: getItems,
			do: softFailItem,
			parallel: true,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "parSoftFail", {
		items: [{ value: 1 }, { shouldFail: true }, { value: 3 }],
	});

	assert(result.status === "completed", "workflow completed with parallel soft failure");

	const loopResult = result.results?.loopSoftPar;
	assert(loopResult !== undefined, "parallel loop result exists");
	if (!loopResult) return;
	assert(loopResult.status === "completed", "parallel loop completed");

	const iterations = (
		loopResult.result as {
			iterations: Array<{ results: Record<string, { status: string }> }>;
		}
	).iterations;
	assert(iterations.length === 3, "all parallel iterations ran");
	assert(
		iterations.some((it) => it.results.softFailItem?.status === "failed"),
		"soft-failed iteration captured",
	);
}

// =============================================================================
// TEST: EXECUTION — nested forEach recursion
// =============================================================================

async function testNestedForEachRecursion() {
	console.log("\n--- TEST: Execution — nested forEach recursion ---\n");

	const innerWorkflow = createWorkflow("innerBody")
		.forEach("numbers", {
			items: getGroupNumbers,
			do: squareNumber,
		})
		.build();

	const workflow = createWorkflow("nestedLoops")
		.forEach("groups", {
			items: getGroups,
			do: innerWorkflow,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "nestedLoops", {
		groups: [{ numbers: [2, 3] }, { numbers: [4] }],
	});

	assert(result.status === "completed", "workflow completed with nested loops");

	const outerLoop = result.results?.groups;
	assert(outerLoop !== undefined, "outer loop result exists");
	if (!outerLoop) return;
	assert(outerLoop.status === "completed", "outer loop completed");

	const outerIterations = (
		outerLoop.result as {
			iterations: Array<{
				results: Record<
					string,
					{
						status: string;
						result: {
							iterations: Array<{
								results: Record<string, { result: { squared: number } }>;
							}>;
						};
					}
				>;
			}>;
		}
	).iterations;

	assert(outerIterations.length === 2, "outer loop has 2 iterations");
	const inner0 = outerIterations[0].results.numbers;
	const inner1 = outerIterations[1].results.numbers;
	assert(inner0.status === "completed", "first nested loop completed");
	assert(inner1.status === "completed", "second nested loop completed");
	assert(inner0.result.iterations.length === 2, "first group has 2 numbers");
	assert(inner1.result.iterations.length === 1, "second group has 1 number");
	assert(inner0.result.iterations[0].results.squareNumber.result.squared === 4, "2 squared is 4");
	assert(inner0.result.iterations[1].results.squareNumber.result.squared === 9, "3 squared is 9");
	assert(inner1.result.iterations[0].results.squareNumber.result.squared === 16, "4 squared is 16");
}

// =============================================================================
// TEST: EXECUTION — nested forEach with outer parallel
// =============================================================================

async function testNestedForEachOuterParallel() {
	console.log("\n--- TEST: Execution — nested forEach with outer parallel ---\n");

	const innerWorkflow = createWorkflow("innerOuterPar")
		.forEach("numbers", {
			items: getGroupNumbers,
			do: squareNumber,
		})
		.build();

	const workflow = createWorkflow("nestedOuterParallel")
		.forEach("groups", {
			items: getGroups,
			do: innerWorkflow,
			parallel: true,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "nestedOuterParallel", {
		groups: [{ numbers: [2, 3] }, { numbers: [4] }],
	});

	assert(result.status === "completed", "workflow completed with outer parallel nested loops");

	const outerLoop = result.results?.groups;
	assert(outerLoop !== undefined, "outer loop result exists");
	if (!outerLoop) return;
	assert(outerLoop.status === "completed", "outer loop completed");

	const outerIterations = (
		outerLoop.result as {
			iterations: Array<{
				index: number;
				results: Record<
					string,
					{
						status: string;
						result: {
							iterations: Array<{
								results: Record<string, { result: { squared: number } }>;
							}>;
						};
					}
				>;
			}>;
		}
	).iterations;

	assert(outerIterations.length === 2, "outer loop has 2 iterations");
	assert(outerIterations[0].index === 0, "outer iteration 0 present");
	assert(outerIterations[1].index === 1, "outer iteration 1 present");

	const inner0 = outerIterations[0].results.numbers;
	const inner1 = outerIterations[1].results.numbers;
	assert(inner0.status === "completed", "first nested loop completed");
	assert(inner1.status === "completed", "second nested loop completed");
	assert(inner0.result.iterations.length === 2, "first group has 2 numbers");
	assert(inner1.result.iterations.length === 1, "second group has 1 number");
}

// =============================================================================
// TEST: EXECUTION — nested forEach with inner parallel
// =============================================================================

async function testNestedForEachInnerParallel() {
	console.log("\n--- TEST: Execution — nested forEach with inner parallel ---\n");

	const innerWorkflow = createWorkflow("innerPar")
		.forEach("numbers", {
			items: getGroupNumbers,
			do: squareNumber,
			parallel: true,
		})
		.build();

	const workflow = createWorkflow("nestedInnerParallel")
		.forEach("groups", {
			items: getGroups,
			do: innerWorkflow,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "nestedInnerParallel", {
		groups: [{ numbers: [2, 3] }, { numbers: [4] }],
	});

	assert(result.status === "completed", "workflow completed with inner parallel nested loops");

	const outerLoop = result.results?.groups;
	assert(outerLoop !== undefined, "outer loop result exists");
	if (!outerLoop) return;
	assert(outerLoop.status === "completed", "outer loop completed");

	const outerIterations = (
		outerLoop.result as {
			iterations: Array<{
				results: Record<
					string,
					{
						status: string;
						result: {
							iterations: Array<{
								index: number;
								results: Record<string, { result: { squared: number } }>;
							}>;
						};
					}
				>;
			}>;
		}
	).iterations;

	assert(outerIterations.length === 2, "outer loop has 2 iterations");
	const inner0 = outerIterations[0].results.numbers;
	const inner1 = outerIterations[1].results.numbers;
	assert(inner0.status === "completed", "first nested loop completed");
	assert(inner1.status === "completed", "second nested loop completed");
	assert(inner0.result.iterations.length === 2, "first group has 2 numbers");
	assert(inner1.result.iterations.length === 1, "second group has 1 number");
	assert(inner0.result.iterations[0].index === 0, "inner parallel preserves first index");
	assert(inner0.result.iterations[1].index === 1, "inner parallel preserves second index");
}

// =============================================================================
// TEST: EXECUTION — nested forEach hard failure propagation (sequential outer)
// =============================================================================

async function testNestedForEachInnerHardFailureSequentialOuter() {
	console.log("\n--- TEST: Execution — nested forEach hard failure (sequential outer) ---\n");

	const innerWorkflow = createWorkflow("innerHardFail")
		.forEach("numbers", {
			items: getGroupNumbers,
			do: squareOrFailOnThree,
		})
		.build();

	const workflow = createWorkflow("nestedHardFailSeqOuter")
		.forEach("groups", {
			items: getGroups,
			do: innerWorkflow,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "nestedHardFailSeqOuter", {
		groups: [{ numbers: [2, 3] }, { numbers: [4] }],
	});

	assert(result.status === "failed", "workflow failed");
	assert(result.failedStep === "groups", "failedStep is outer loop name");

	const outerLoop = result.results?.groups;
	assert(outerLoop !== undefined, "outer loop result exists");
	if (!outerLoop) return;
	assert(outerLoop.status === "failed", "outer loop failed");

	const outerIterations = (
		outerLoop.result as {
			iterations: Array<{
				results: Record<
					string,
					{
						status: string;
						result: {
							iterations: Array<{
								results: Record<string, { status: string }>;
							}>;
						};
					}
				>;
			}>;
		}
	).iterations;

	assert(outerIterations.length === 1, "outer loop stopped after failing first group");
	const inner = outerIterations[0].results.numbers;
	assert(inner.status === "failed", "inner loop failed");
	assert(inner.result.iterations.length === 2, "inner loop captured iterations until failure");
	assert(
		inner.result.iterations[1].results.squareOrFailOnThree.status === "failed",
		"failing inner iteration is marked failed",
	);
}

// =============================================================================
// TEST: EXECUTION — nested forEach hard failure propagation (parallel outer)
// =============================================================================

async function testNestedForEachInnerHardFailureParallelOuter() {
	console.log("\n--- TEST: Execution — nested forEach hard failure (parallel outer) ---\n");

	const innerWorkflow = createWorkflow("innerHardFailParOuter")
		.forEach("numbers", {
			items: getGroupNumbers,
			do: squareOrFailOnThree,
		})
		.build();

	const workflow = createWorkflow("nestedHardFailParOuter")
		.forEach("groups", {
			items: getGroups,
			do: innerWorkflow,
			parallel: true,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "nestedHardFailParOuter", {
		groups: [{ numbers: [2, 3] }, { numbers: [4] }],
	});

	assert(result.status === "failed", "workflow failed");
	assert(result.failedStep === "groups", "failedStep is outer loop name");

	const outerLoop = result.results?.groups;
	assert(outerLoop !== undefined, "outer loop result exists");
	if (!outerLoop) return;
	assert(outerLoop.status === "failed", "outer loop failed");

	const outerIterations = (
		outerLoop.result as {
			iterations: Array<{
				results: Record<string, { status: string }>;
			}>;
		}
	).iterations;

	assert(outerIterations.length === 2, "parallel outer loop settled all iterations");
	assert(
		outerIterations.some((it) => it.results.numbers?.status === "failed"),
		"at least one inner loop failed",
	);
	assert(
		outerIterations.some((it) => it.results.numbers?.status === "completed"),
		"at least one inner loop completed",
	);
}

// =============================================================================
// TEST: EXECUTION — nested forEach continueOnError in inner loop
// =============================================================================

async function testNestedForEachInnerContinueOnError() {
	console.log("\n--- TEST: Execution — nested forEach continueOnError in inner loop ---\n");

	const innerWorkflow = createWorkflow("innerSoftFail")
		.forEach("numbers", {
			items: getGroupNumbers,
			do: squareOrSoftFailOnThree,
		})
		.build();

	const workflow = createWorkflow("nestedSoftFail")
		.forEach("groups", {
			items: getGroups,
			do: innerWorkflow,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "nestedSoftFail", {
		groups: [{ numbers: [2, 3] }, { numbers: [4] }],
	});

	assert(result.status === "completed", "workflow completed");

	const outerLoop = result.results?.groups;
	assert(outerLoop !== undefined, "outer loop result exists");
	if (!outerLoop) return;
	assert(outerLoop.status === "completed", "outer loop completed");

	const outerIterations = (
		outerLoop.result as {
			iterations: Array<{
				results: Record<
					string,
					{
						status: string;
						result: {
							iterations: Array<{
								results: Record<string, { status: string }>;
							}>;
						};
					}
				>;
			}>;
		}
	).iterations;

	const firstInner = outerIterations[0].results.numbers;
	assert(firstInner.status === "completed", "inner loop completed despite soft failure");
	assert(
		firstInner.result.iterations[1].results.squareOrSoftFailOnThree.status === "failed",
		"inner soft-failed step is captured as failed",
	);
}

// =============================================================================
// TEST: EXECUTION — retry behavior in sequential forEach
// =============================================================================

async function testRetrySequentialForEach() {
	console.log("\n--- TEST: Execution — retry behavior in sequential forEach ---\n");
	resetRetryAttempts();

	const doFlow = createWorkflow("retryDoSeq")
		.step({ name: "retryByItemId", fn: retryByItemId, maxAttempts: 3 })
		.build();

	const workflow = createWorkflow("retrySeqLoop")
		.forEach("itemsLoop", {
			items: getItems,
			do: doFlow,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "retrySeqLoop", {
		items: [{ id: "a" }, { id: "b" }],
	});

	assert(result.status === "completed", "workflow completed");
	const iterations = (
		result.results?.itemsLoop.result as {
			iterations: Array<{ results: Record<string, { result: { attempt: number } }> }>;
		}
	).iterations;
	assert(iterations.length === 2, "all sequential iterations ran");
	assert(
		iterations[0].results.retryByItemId.result.attempt === 3,
		"first item retried to attempt 3",
	);
	assert(
		iterations[1].results.retryByItemId.result.attempt === 3,
		"second item retried to attempt 3",
	);
}

// =============================================================================
// TEST: EXECUTION — retry behavior in parallel forEach
// =============================================================================

async function testRetryParallelForEach() {
	console.log("\n--- TEST: Execution — retry behavior in parallel forEach ---\n");
	resetRetryAttempts();

	const doFlow = createWorkflow("retryDoPar")
		.step({ name: "retryByItemId", fn: retryByItemId, maxAttempts: 3 })
		.build();

	const workflow = createWorkflow("retryParLoop")
		.forEach("itemsLoop", {
			items: getItems,
			do: doFlow,
			parallel: true,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "retryParLoop", {
		items: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
	});

	assert(result.status === "completed", "workflow completed");
	const iterations = (
		result.results?.itemsLoop.result as {
			iterations: Array<{ results: Record<string, { result: { attempt: number } }> }>;
		}
	).iterations;
	assert(iterations.length === 3, "all parallel iterations settled");
	assert(
		iterations[0].results.retryByItemId.result.attempt === 3,
		"iteration 0 retried to attempt 3",
	);
	assert(
		iterations[1].results.retryByItemId.result.attempt === 3,
		"iteration 1 retried to attempt 3",
	);
	assert(
		iterations[2].results.retryByItemId.result.attempt === 3,
		"iteration 2 retried to attempt 3",
	);
}

// =============================================================================
// TEST: EXECUTION — retry behavior in nested forEach
// =============================================================================

async function testNestedForEachRetrySuccess() {
	console.log("\n--- TEST: Execution — retry behavior in nested forEach ---\n");
	resetRetryAttempts();

	const retryBody = createWorkflow("retryBodyNested")
		.step({ name: "retryByItemId", fn: retryByItemId, maxAttempts: 3 })
		.build();

	const innerWorkflow = createWorkflow("innerRetryLoop")
		.forEach("retryItems", {
			items: getGroupRetryItems,
			do: retryBody,
		})
		.build();

	const workflow = createWorkflow("nestedRetrySuccess")
		.forEach("groups", {
			items: getGroups,
			do: innerWorkflow,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "nestedRetrySuccess", {
		groups: [{ retryItems: [{ id: "g1-i1" }, { id: "g1-i2" }] }, { retryItems: [{ id: "g2-i1" }] }],
	});

	assert(result.status === "completed", "nested workflow completed");

	const outerIterations = (
		result.results?.groups.result as {
			iterations: Array<{
				results: Record<
					string,
					{
						result: {
							iterations: Array<{
								results: Record<string, { result: { attempt: number } }>;
							}>;
						};
					}
				>;
			}>;
		}
	).iterations;
	assert(outerIterations.length === 2, "outer loop has 2 iterations");
	assert(
		outerIterations[0].results.retryItems.result.iterations[0].results.retryByItemId.result
			.attempt === 3,
		"nested first item retried to attempt 3",
	);
	assert(
		outerIterations[0].results.retryItems.result.iterations[1].results.retryByItemId.result
			.attempt === 3,
		"nested second item retried to attempt 3",
	);
	assert(
		outerIterations[1].results.retryItems.result.iterations[0].results.retryByItemId.result
			.attempt === 3,
		"nested third item retried to attempt 3",
	);
}

// =============================================================================
// TEST: EXECUTION — retry exhaustion in nested forEach fails workflow
// =============================================================================

async function testNestedForEachRetryExhaustionFails() {
	console.log("\n--- TEST: Execution — nested forEach retry exhaustion fails workflow ---\n");
	resetRetryAttempts();

	const retryBody = createWorkflow("retryBodyExhausted")
		.step({ name: "retryByItemId", fn: retryByItemId, maxAttempts: 2 })
		.build();

	const innerWorkflow = createWorkflow("innerRetryExhausted")
		.forEach("retryItems", {
			items: getGroupRetryItems,
			do: retryBody,
		})
		.build();

	const workflow = createWorkflow("nestedRetryExhausted")
		.forEach("groups", {
			items: getGroups,
			do: innerWorkflow,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "nestedRetryExhausted", {
		groups: [{ retryItems: [{ id: "exhausted", failUntil: 3 }] }],
	});

	assert(result.status === "failed", "nested workflow failed when retries exhausted");
	assert(result.failedStep === "groups", "failedStep is outer loop");
}

// =============================================================================
// TEST: EXECUTION — empty items array
// =============================================================================

async function testEmptyItems() {
	console.log("\n--- TEST: Execution — empty items array ---\n");

	const workflow = createWorkflow("emptyLoop")
		.forEach("processEach", {
			items: getItems,
			do: processItem,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "emptyLoop", { items: [] });

	assert(result.status === "completed", "workflow completed");

	const loopResult = result.results?.processEach;
	assert(loopResult !== undefined, "loop result exists");
	if (!loopResult) return;
	assert(loopResult.status === "completed", "loop completed");

	const iterations = (loopResult.result as { iterations: unknown[] }).iterations;
	assert(iterations.length === 0, "0 iterations");
}

// =============================================================================
// TEST: EXECUTION — via Engine rival() API
// =============================================================================

async function testViaEngine() {
	console.log("\n--- TEST: Execution — via Engine rival() API ---\n");

	const workflow = createWorkflow("engineLoop")
		.forEach("processEach", {
			items: getItems,
			do: doubleItem,
		})
		.build();

	const engine = rival(workflow);

	assert(engine.list().includes("engineLoop"), "engine has workflow");

	const result = await runToTerminal(engine, "engineLoop", { items: [5, 10] });
	assert(result.status === "completed", "workflow completed via engine");

	const iterations = (
		result.results?.processEach.result as {
			iterations: Array<{ results: Record<string, { result: { doubled: number } }> }>;
		}
	).iterations;
	assert(iterations[0].results.doubleItem.result.doubled === 10, "5 doubled is 10");
	assert(iterations[1].results.doubleItem.result.doubled === 20, "10 doubled is 20");
}

// =============================================================================
// TEST: EXECUTION — cancel during active loop execution
// =============================================================================

async function testCancelDuringLoopExecution() {
	console.log("\n--- TEST: Execution — cancel during active loop execution ---\n");

	const workflow = createWorkflow("cancelLoop")
		.forEach("processEach", {
			items: getItems,
			do: slowProcessItem,
		})
		.build();

	const engine = rival(workflow);
	const runId = `cancel-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const start = await engine.run("cancelLoop", { items: [1, 2, 3, 4, 5] }, runId);
	assert(!!start.runId, "run() returns runId");

	const instance = engine.get("cancelLoop").getOrCreate(runId);
	await new Promise((resolve) => setTimeout(resolve, 10));
	await instance.cancel();

	const result = await engine.wait("cancelLoop", runId);
	assert(result.status === "cancelled", "workflow cancelled during active loop");
}

// =============================================================================
// TEST: EXECUTION — iterator returning non-array fails
// =============================================================================

async function testNonArrayIterator() {
	console.log("\n--- TEST: Execution — iterator returning non-array fails ---\n");

	const workflow = createWorkflow("badIterator")
		.forEach("badLoop", {
			items: returnNonArray,
			do: processItem,
		})
		.build();

	const engine = rival(workflow);
	const result = await runToTerminal(engine, "badIterator", {});

	assert(result.status === "failed", "workflow failed");
	assert(result.error !== undefined, "error present");
	assert(result.error?.includes("must return an array") === true, "descriptive error message");
}

// =============================================================================
// TEST: BUILDER — names containing __ rejected
// =============================================================================

async function testDoubleUnderscoreRejected() {
	console.log("\n--- TEST: Builder — names containing __ rejected ---\n");

	try {
		createWorkflow("badName").forEach("bad__name", { items: getItems, do: processItem }).build();
		assert(false, "should have thrown");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("__"), "error mentions __");
	}

	try {
		createWorkflow("badStep").step({ fn: processItem, name: "step__bad" }).build();
		assert(false, "should have thrown for step name");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("__"), "error mentions __ for step");
	}
}

// =============================================================================
// TEST: COMPILER — do step named "iterator" does not collide
// =============================================================================

async function testIteratorNameNoCollision() {
	console.log("\n--- TEST: Compiler — do step named 'iterator' no collision ---\n");

	function iterator({ loop }: StepContext) {
		return { item: loop?.item };
	}

	const workflow = createWorkflow("iterCollision")
		.forEach("myLoop", {
			items: getItems,
			do: iterator,
		})
		.build();

	const compiled = compileWorkflow(workflow);
	const actorNames = Object.keys(compiled.actors);

	// Iterator actor and do actor should have different refs
	assert(actorNames.includes("iterCollision__loop__myLoop__iterator"), "has iterator actor");
	assert(
		actorNames.includes("iterCollision__loop__myLoop__do__iterator"),
		"has do actor (distinct from iterator)",
	);

	// Should also work at runtime
	const engine = rival(workflow);
	const result = await runToTerminal(engine, "iterCollision", { items: [42] });
	assert(result.status === "completed", "workflow with 'iterator' do step runs");

	const iterations = (
		result.results?.myLoop.result as {
			iterations: Array<{ results: Record<string, { result: { item: unknown } }> }>;
		}
	).iterations;
	assert(iterations[0].results.iterator.result.item === 42, "do step ran correctly");
}

// =============================================================================
// RUN ALL
// =============================================================================

async function main() {
	console.log("============================================================");
	console.log("RIVAL TEST - ForEach Loop");
	console.log("============================================================");

	await testBuilderSingleStep();
	await testBuilderWorkflowDo();
	await testBuilderConcurrencyValidation();
	await testBuilderDuplicateForEachName();
	await testBuilderNameCollision();
	await testCompiler();
	await testCompilerWorkflowDo();
	await testCompilerLoopCoordinatorAndConcurrency();
	await testSequentialExecution();
	await testParallelExecution();
	await testLoopContext();
	await testBodyStepVisibility();
	await testBeforeAfterLoop();
	await testLastStepAfterLoop();
	await testHardFailureStopsLoop();
	await testStepsAfterFailedLoopSkipped();
	await testContinueOnError();
	await testParallelHardFailureFailsWorkflow();
	await testParallelContinueOnError();
	await testNestedForEachRecursion();
	await testNestedForEachOuterParallel();
	await testNestedForEachInnerParallel();
	await testNestedForEachInnerHardFailureSequentialOuter();
	await testNestedForEachInnerHardFailureParallelOuter();
	await testNestedForEachInnerContinueOnError();
	await testRetrySequentialForEach();
	await testRetryParallelForEach();
	await testNestedForEachRetrySuccess();
	await testNestedForEachRetryExhaustionFails();
	await testEmptyItems();
	await testViaEngine();
	await testCancelDuringLoopExecution();
	await testNonArrayIterator();
	await testDoubleUnderscoreRejected();
	await testIteratorNameNoCollision();

	console.log("\n============================================================");
	console.log(`Results: ${passed} passed, ${failed} failed`);
	console.log("============================================================\n");

	if (failed > 0) {
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("\nFAILED:", err);
	process.exit(1);
});
