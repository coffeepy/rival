/**
 * Engine Test
 *
 * Tests the rival() convenience API and RivalEngine:
 * - Single workflow (WorkflowDefinition input)
 * - Single workflow (CompiledWorkflow input)
 * - Multiple workflows, run each by name
 * - Unknown workflow name → helpful error
 * - Auto-generated runId works
 * - engine.list() returns names
 * - engine.get() returns coordinator handle
 * - Duplicate workflow/actor name rejection
 *
 * Run with: bun test/engine.test.ts
 */

import { type StepContext, compileWorkflow, createWorkflow, rival } from "../src/rival";

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

// Simple step functions for testing
function addOne({ input }: StepContext) {
	const val = (input as { value?: number })?.value ?? 0;
	return { value: val + 1 };
}

function double({ steps }: StepContext) {
	const prev = steps.addOne?.result as { value: number } | undefined;
	return { value: (prev?.value ?? 0) * 2 };
}

function greet({ input }: StepContext) {
	const name = (input as { name?: string })?.name ?? "world";
	return { message: `Hello, ${name}!` };
}

// =============================================================================
// TESTS
// =============================================================================

async function testSingleWorkflowDefinition() {
	console.log("\n--- TEST: Single workflow (WorkflowDefinition) ---\n");

	const workflow = createWorkflow("math").step(addOne).step(double).build();

	const engine = rival(workflow);

	assert(engine.list().length === 1, "engine has 1 workflow");
	assert(engine.list()[0] === "math", "workflow name is 'math'");

	const result = await runToTerminal(engine, "math", { value: 4 });

	assert(result.status === "completed", "workflow completed");
	const doubleResult = result.results?.double?.result as { value: number };
	assert(doubleResult.value === 10, "addOne(4)=5, double(5)=10");
}

async function testSingleCompiledWorkflow() {
	console.log("\n--- TEST: Single workflow (CompiledWorkflow) ---\n");

	const definition = createWorkflow("greetFlow").step(greet).build();

	const compiled = compileWorkflow(definition);
	const engine = rival(compiled);

	assert(engine.list().length === 1, "engine has 1 workflow");
	assert(engine.list()[0] === "greetFlow", "workflow name is 'greetFlow'");

	const result = await runToTerminal(engine, "greetFlow", { name: "Rival" });

	assert(result.status === "completed", "workflow completed");
	const greetResult = result.results?.greet?.result as { message: string };
	assert(greetResult.message === "Hello, Rival!", "greeting is correct");
}

async function testMultipleWorkflows() {
	console.log("\n--- TEST: Multiple workflows ---\n");

	const mathWorkflow = createWorkflow("math").step(addOne).step(double).build();

	const greetWorkflow = createWorkflow("greet").step(greet).build();

	const engine = rival(mathWorkflow, greetWorkflow);

	assert(engine.list().length === 2, "engine has 2 workflows");
	assert(engine.list().includes("math"), "has 'math' workflow");
	assert(engine.list().includes("greet"), "has 'greet' workflow");

	const mathResult = await runToTerminal(engine, "math", { value: 9 });
	assert(mathResult.status === "completed", "math workflow completed");
	const doubleResult = mathResult.results?.double?.result as { value: number };
	assert(doubleResult.value === 20, "addOne(9)=10, double(10)=20");

	const greetResult = await runToTerminal(engine, "greet", { name: "World" });
	assert(greetResult.status === "completed", "greet workflow completed");
	const msg = greetResult.results?.greet?.result as { message: string };
	assert(msg.message === "Hello, World!", "greeting is correct");
}

async function testUnknownWorkflowError() {
	console.log("\n--- TEST: Unknown workflow name → error ---\n");

	const workflow = createWorkflow("onlyOne").step(addOne).build();

	const engine = rival(workflow);

	try {
		await engine.run("nonexistent");
		assert(false, "should have thrown");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("nonexistent"), "error mentions the bad name");
		assert(msg.includes("onlyOne"), "error lists available workflows");
	}
}

async function testAutoRunId() {
	console.log("\n--- TEST: Auto-generated runId ---\n");

	const workflow = createWorkflow("autoId").step(addOne).build();

	const engine = rival(workflow);

	// Run without specifying runId — should auto-generate and succeed
	const result = await runToTerminal(engine, "autoId", { value: 0 });
	assert(result.status === "completed", "workflow completed with auto-runId");
}

async function testExplicitRunId() {
	console.log("\n--- TEST: Explicit runId ---\n");

	const workflow = createWorkflow("explicitId").step(addOne).build();

	const engine = rival(workflow);

	const explicitRunId = `my-custom-run-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const result = await runToTerminal(engine, "explicitId", { value: 0 }, explicitRunId);
	assert(result.status === "completed", "workflow completed with explicit runId");
}

async function testEngineList() {
	console.log("\n--- TEST: engine.list() ---\n");

	const w1 = createWorkflow("alpha").step(addOne).build();
	const w2 = createWorkflow("beta").step(double).build();
	const w3 = createWorkflow("gamma").step(greet).build();

	const engine = rival(w1, w2, w3);

	const names = engine.list();
	assert(names.length === 3, "list has 3 entries");
	assert(names.includes("alpha"), "includes alpha");
	assert(names.includes("beta"), "includes beta");
	assert(names.includes("gamma"), "includes gamma");
}

async function testDuplicateWorkflowNameRejected() {
	console.log("\n--- TEST: Duplicate workflow name rejected ---\n");

	const w1 = createWorkflow("sameName").step(addOne).build();
	const w2 = createWorkflow("sameName").step(greet).build();

	try {
		rival(w1, w2);
		assert(false, "should have thrown for duplicate workflow name");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("already registered"), "error mentions already registered");
		assert(msg.includes("sameName"), "error mentions the duplicate name");
	}
}

async function testDuplicateActorNameRejected() {
	console.log("\n--- TEST: Duplicate actor name rejected ---\n");

	const w1 = compileWorkflow(createWorkflow("flow1").step(addOne).build());
	const w2 = compileWorkflow(createWorkflow("flow2").step(addOne).build());

	// Manually inject a colliding actor name into w2
	const collidingActorName = Object.keys(w1.actors)[0];
	w2.actors[collidingActorName] = Object.values(w2.actors)[0];

	try {
		rival(w1, w2);
		assert(false, "should have thrown for duplicate actor name");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("Duplicate actor name"), "error mentions duplicate actor name");
	}
}

async function testGetCoordinatorHandle() {
	console.log("\n--- TEST: engine.get() returns coordinator handle ---\n");

	const workflow = createWorkflow("getTest").step(addOne).build();

	const engine = rival(workflow);

	const coord = engine.get("getTest");
	assert(typeof coord.getOrCreate === "function", "handle has getOrCreate()");

	// Get a run instance
	const runId = `run-get-1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const instance = coord.getOrCreate(runId);
	assert(typeof instance.run === "function", "instance has run()");
	assert(typeof instance.cancel === "function", "instance has cancel()");
	assert(typeof instance.getState === "function", "instance has getState()");

	// Use the instance directly to run a workflow
	const start = await instance.run(runId, { value: 7 });
	assert(start.runId === runId, "instance.run returns runId");
	const result = await instance.wait();
	assert(result.status === "completed", "workflow completed via handle");
	const addResult = result.results?.addOne?.result as { value: number };
	assert(addResult.value === 8, "addOne(7)=8 via handle");

	// Check state via instance
	const state = await instance.getState();
	assert(state.status === "completed", "getState shows completed");
	assert(state.duration !== null, "duration is set");
}

async function testGetUnknownWorkflowError() {
	console.log("\n--- TEST: engine.get() unknown workflow → error ---\n");

	const workflow = createWorkflow("exists").step(addOne).build();

	const engine = rival(workflow);

	try {
		engine.get("nope");
		assert(false, "should have thrown");
	} catch (err) {
		const msg = (err as Error).message;
		assert(msg.includes("nope"), "error mentions the bad name");
		assert(msg.includes("exists"), "error lists available workflows");
	}
}

async function testGetRunAndInspect() {
	console.log("\n--- TEST: get() → run → getState lifecycle ---\n");

	const workflow = createWorkflow("lifecycle").step(addOne).build();

	const engine = rival(workflow);

	// Use get() to run directly
	const coord = engine.get("lifecycle");
	const runId = `lc-run-1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const instance = coord.getOrCreate(runId);

	// Verify full API surface
	assert(typeof instance.run === "function", "instance has run()");
	assert(typeof instance.cancel === "function", "instance has cancel()");
	assert(typeof instance.getState === "function", "instance has getState()");

	// Run via handle
	const start = await instance.run(runId, { value: 41 });
	assert(start.runId === runId, "instance.run returns runId");
	const result = await instance.wait();
	assert(result.status === "completed", "workflow completed via get()");

	const addResult = result.results?.addOne?.result as { value: number };
	assert(addResult.value === 42, "addOne(41)=42");

	// Inspect state via handle
	const state = await instance.getState();
	assert(state.status === "completed", "getState shows completed");
	assert(state.duration !== null, "duration is set");
}

// =============================================================================
// RUN ALL
// =============================================================================

async function main() {
	console.log("============================================================");
	console.log("RIVAL TEST - Engine API");
	console.log("============================================================");

	await testSingleWorkflowDefinition();
	await testSingleCompiledWorkflow();
	await testMultipleWorkflows();
	await testUnknownWorkflowError();
	await testAutoRunId();
	await testExplicitRunId();
	await testEngineList();
	await testDuplicateWorkflowNameRejected();
	await testDuplicateActorNameRejected();
	await testGetCoordinatorHandle();
	await testGetUnknownWorkflowError();
	await testGetRunAndInspect();

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
