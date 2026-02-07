/**
 * Phase 3 Test
 *
 * Tests the workflow registry functionality:
 * - WorkflowRegistry class
 * - createRegistryActor
 * - Workflow launching and tracking
 * - Run cancellation
 *
 * Run with: bun test/phase3.test.ts
 */

import { setup } from "rivetkit";
import { z } from "zod";
import {
	type StepContext,
	WorkflowRegistry,
	compileWorkflow,
	createRegistryActor,
	createWorkflow,
} from "../src/rival";

// =============================================================================
// STEP FUNCTIONS
// =============================================================================

function stepOne({ log }: StepContext) {
	log.info("Step one executing");
	return { step: 1, done: true };
}

function stepTwo({ steps, log }: StepContext) {
	const prev = steps.stepOne?.result as { step: number } | undefined;
	log.info(`Step two executing after step ${prev?.step}`);
	return { step: 2, done: true };
}

function slowStep({ log }: StepContext) {
	log.info("Slow step starting...");
	return new Promise((resolve) => {
		setTimeout(() => {
			log.info("Slow step done");
			resolve({ slow: true, done: true });
		}, 100);
	});
}

// =============================================================================
// TEST: WORKFLOW REGISTRY CLASS
// =============================================================================

async function testWorkflowRegistry() {
	console.log("--- TEST: WorkflowRegistry Class ---\n");

	const registry = new WorkflowRegistry();

	// Compile some workflows
	const workflow1 = compileWorkflow(
		createWorkflow("testFlow1").step(stepOne).step(stepTwo).build(),
	);

	const workflow2 = compileWorkflow(
		createWorkflow("testFlow2")
			.input(z.object({ name: z.string() }))
			.step(stepOne)
			.build(),
	);

	// Test register
	registry.register(workflow1);
	registry.register(workflow2);
	console.log("Registered 2 workflows");

	// Test has
	if (!registry.has("testFlow1") || !registry.has("testFlow2")) {
		throw new Error("has() failed");
	}
	console.log("has() works correctly");

	// Test get
	const retrieved = registry.get("testFlow1");
	if (!retrieved || retrieved.name !== "testFlow1") {
		throw new Error("get() failed");
	}
	console.log("get() works correctly");

	// Test list
	const list = registry.list();
	if (list.length !== 2) {
		throw new Error(`list() returned ${list.length} items, expected 2`);
	}
	console.log("list() returned:", list.map((w) => w.name).join(", "));

	// Test getAllActors
	const allActors = registry.getAllActors();
	const actorNames = Object.keys(allActors);
	console.log(`getAllActors() returned ${actorNames.length} actors`);

	const expectedActors = [
		"testFlow1_stepOne",
		"testFlow1_stepTwo",
		"testFlow1_coordinator",
		"testFlow2_stepOne",
		"testFlow2_coordinator",
	];

	for (const expected of expectedActors) {
		if (!allActors[expected]) {
			throw new Error(`Missing expected actor: ${expected}`);
		}
	}
	console.log("All expected actors present");

	// Test duplicate registration error
	try {
		registry.register(workflow1);
		throw new Error("Should have thrown for duplicate registration");
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes("already registered")) {
			throw err;
		}
		console.log("Duplicate registration correctly rejected");
	}

	// Test clear
	registry.clear();
	if (registry.has("testFlow1")) {
		throw new Error("clear() failed");
	}
	console.log("clear() works correctly");

	console.log("\n[WorkflowRegistry tests passed]\n");
	return true;
}

// =============================================================================
// TEST: REGISTRY ACTOR
// =============================================================================

async function testRegistryActor() {
	console.log("--- TEST: Registry Actor ---\n");

	// Create a fresh registry for this test
	const registry = new WorkflowRegistry();

	// Compile and register workflows
	const simpleWorkflow = compileWorkflow(
		createWorkflow("simpleFlow").step(stepOne).step(stepTwo).build(),
	);

	const slowWorkflow = compileWorkflow(createWorkflow("slowFlow").step(slowStep).build());

	registry.register(simpleWorkflow);
	registry.register(slowWorkflow);

	// Create the registry actor
	const registryActor = createRegistryActor(registry);

	// Collect all actors (workflow actors + registry actor)
	const allActors = {
		...registry.getAllActors(),
		workflowRegistry: registryActor,
	};

	// Setup RivetKit
	const rivet = setup({
		use: allActors as Parameters<typeof setup>[0]["use"],
	});

	const { client } = rivet.start({
		disableDefaultServer: true,
		noWelcome: true,
	});

	// Get the registry actor instance
	const registryInstance = (client as Record<string, unknown>).workflowRegistry as {
		getOrCreate: (id: string) => {
			list: () => Promise<{ name: string; stepCount: number }[]>;
			launch: (
				name: string,
				input: unknown,
				runId?: string,
			) => Promise<{ runId: string; status: string; error?: string }>;
			getActiveRuns: (name?: string) => Promise<{ runId: string; status: string }[]>;
			getRunStatus: (runId: string) => Promise<{ runId: string; status: string } | undefined>;
			cancel: (runId: string) => Promise<{ success: boolean; error?: string }>;
		};
	};

	const reg = registryInstance.getOrCreate("main");

	// Test list
	const workflows = await reg.list();
	console.log(
		"Listed workflows:",
		workflows.map((w) => `${w.name} (${w.stepCount} steps)`).join(", "),
	);

	if (workflows.length !== 2) {
		throw new Error(`Expected 2 workflows, got ${workflows.length}`);
	}

	// Test launch
	console.log("\nLaunching simpleFlow...");
	const launchResult = await reg.launch("simpleFlow", {}, "test-run-1");
	console.log("Launch result:", launchResult);

	if (launchResult.status !== "started") {
		throw new Error(`Expected 'started', got '${launchResult.status}'`);
	}

	// Wait for workflow to complete
	await new Promise((resolve) => setTimeout(resolve, 200));

	// Test getRunStatus
	const runStatus = await reg.getRunStatus("test-run-1");
	console.log("Run status:", runStatus);

	if (!runStatus || runStatus.status !== "completed") {
		throw new Error(`Expected 'completed', got '${runStatus?.status}'`);
	}

	// Test getActiveRuns
	const activeRuns = await reg.getActiveRuns();
	console.log(`Active runs: ${activeRuns.length}`);

	// Test launching non-existent workflow
	const badLaunch = await reg.launch("nonExistent", {});
	if (badLaunch.status !== "failed" || !badLaunch.error?.includes("not found")) {
		throw new Error("Should have failed for non-existent workflow");
	}
	console.log("Non-existent workflow correctly rejected");

	console.log("\n[Registry Actor tests passed]\n");
	return true;
}

// =============================================================================
// TEST: WORKFLOW LAUNCHING AND EXECUTION
// =============================================================================

async function testWorkflowLaunching() {
	console.log("--- TEST: Workflow Launching ---\n");

	const registry = new WorkflowRegistry();

	// Create workflow with input validation
	const inputSchema = z.object({
		userId: z.string(),
		action: z.enum(["create", "update", "delete"]),
	});

	const userWorkflow = compileWorkflow(
		createWorkflow("userAction")
			.input(inputSchema)
			.step(function processAction({ input, log }: StepContext) {
				const data = input as { userId: string; action: string };
				log.info(`Processing ${data.action} for user ${data.userId}`);
				return { processed: true, userId: data.userId, action: data.action };
			})
			.build(),
	);

	registry.register(userWorkflow);

	const registryActor = createRegistryActor(registry);

	const rivet = setup({
		use: {
			...registry.getAllActors(),
			workflowRegistry: registryActor,
		} as Parameters<typeof setup>[0]["use"],
	});

	const { client } = rivet.start({
		disableDefaultServer: true,
		noWelcome: true,
	});

	const reg = (client as Record<string, unknown>).workflowRegistry as {
		getOrCreate: (id: string) => {
			launch: (
				name: string,
				input: unknown,
				runId?: string,
			) => Promise<{ runId: string; status: string }>;
			getRunStatus: (runId: string) => Promise<{ runId: string; status: string } | undefined>;
		};
	};

	const instance = reg.getOrCreate("main");

	// Launch with valid input
	console.log("Launching with valid input...");
	const result = await instance.launch(
		"userAction",
		{ userId: "user-123", action: "create" },
		"user-run-1",
	);

	if (result.status !== "started") {
		throw new Error(`Expected started, got ${result.status}`);
	}

	// Wait for completion
	await new Promise((resolve) => setTimeout(resolve, 100));

	const status = await instance.getRunStatus("user-run-1");
	console.log("Final status:", status?.status);

	if (status?.status !== "completed") {
		throw new Error(`Expected completed, got ${status?.status}`);
	}

	console.log("\n[Workflow Launching tests passed]\n");
	return true;
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

async function main() {
	console.log(`\n${"=".repeat(60)}`);
	console.log("RIVAL PHASE 3 TEST - Registry");
	console.log(`${"=".repeat(60)}\n`);

	const results: Record<string, boolean> = {};

	try {
		results.workflowRegistry = await testWorkflowRegistry();
	} catch (e) {
		console.error("WorkflowRegistry test failed:", e);
		results.workflowRegistry = false;
	}

	try {
		results.registryActor = await testRegistryActor();
	} catch (e) {
		console.error("Registry Actor test failed:", e);
		results.registryActor = false;
	}

	try {
		results.workflowLaunching = await testWorkflowLaunching();
	} catch (e) {
		console.error("Workflow Launching test failed:", e);
		results.workflowLaunching = false;
	}

	// Summary
	console.log("=".repeat(60));
	console.log("PHASE 3 TESTS COMPLETE");
	console.log("=".repeat(60));
	console.log("\nResults:");

	let allPassed = true;
	for (const [name, passed] of Object.entries(results)) {
		console.log(`  ${name}: ${passed ? "passed" : "FAILED"}`);
		if (!passed) allPassed = false;
	}

	console.log(`\n${allPassed ? "✓ All tests passed!" : "✗ Some tests failed"}\n`);

	process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
	console.error("\nTEST FAILED:", err);
	process.exit(1);
});
