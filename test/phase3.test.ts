/**
 * Phase 3 Test
 *
 * Tests the workflow registry functionality:
 * - WorkflowRegistry class
 * - createRegistryActor (live-query pattern)
 * - Workflow launching and tracking
 * - Run cancellation
 *
 * Run with: bun test/phase3.test.ts
 */

import { createMemoryDriver, setup } from "rivetkit";
import { z } from "zod";
import {
	type RunStatusInfo,
	type StepContext,
	WorkflowRegistry,
	compileWorkflow,
	createRegistryActor,
	createWorkflow,
} from "../src/rival";
import { waitForStatus } from "./helpers";

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
		// Memory driver keeps the registry + workflow actors fully in-process for tests.
		driver: createMemoryDriver(),
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
			getActiveRuns: (name?: string) => Promise<RunStatusInfo[]>;
			getRunStatus: (runId: string) => Promise<RunStatusInfo | undefined>;
			cancel: (runId: string) => Promise<{ success: boolean; error?: string }>;
		};
	};

	const reg = registryInstance.getOrCreate("main");
	// "main" is the registry actor key. In production you might scope this by tenant.

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

	// Poll for workflow completion via live-query
	// This mirrors frontend behavior: poll run status instead of expecting launch() to block.
	const pollUntilDone = async (runId: string, timeoutMs = 5000): Promise<RunStatusInfo> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const status = await reg.getRunStatus(runId);
			if (status && ["completed", "failed", "cancelled"].includes(status.status)) {
				return status;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`Timed out waiting for run ${runId}`);
	};

	const runStatus = await pollUntilDone("test-run-1");
	console.log("Run status:", { status: runStatus.status, workflowName: runStatus.workflowName });

	if (runStatus.status !== "completed") {
		throw new Error(`Expected 'completed', got '${runStatus.status}'`);
	}

	// Test getActiveRuns (now returns RunStatusInfo with live data)
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
		// Same driver choice here so launch/status semantics are tested without external infra.
		driver: createMemoryDriver(),
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
			getRunStatus: (runId: string) => Promise<RunStatusInfo | undefined>;
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

	// Poll for completion via live-query
	// Registry launch returns quickly; the coordinator advances asynchronously.
	const deadline = Date.now() + 5000;
	let status: RunStatusInfo | undefined;
	while (Date.now() < deadline) {
		status = await instance.getRunStatus("user-run-1");
		if (status && ["completed", "failed", "cancelled"].includes(status.status)) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	console.log("Final status:", status?.status);

	if (status?.status !== "completed") {
		throw new Error(`Expected completed, got ${status?.status}`);
	}

	console.log("\n[Workflow Launching tests passed]\n");
	return true;
}

// =============================================================================
// TEST: CANCELLATION
// =============================================================================

async function testCancellation() {
	console.log("--- TEST: Cancellation ---\n");

	const registry = new WorkflowRegistry();

	// Create a deferred promise (barrier) for deterministic cancellation testing
	// Barrier lets us guarantee cancel is sent while step 1 is in-flight.
	let releaseBarrier!: () => void;
	const barrier = new Promise<void>((resolve) => {
		releaseBarrier = resolve;
	});

	// Step that blocks on the barrier
	function blockingStep({ log }: StepContext) {
		log.info("Blocking step waiting on barrier...");
		return barrier.then(() => {
			log.info("Blocking step released");
			return { blocked: true, released: true };
		});
	}

	function stepAfterBlock({ log }: StepContext) {
		log.info("Step after block - should NOT run");
		return { afterBlock: true };
	}

	function finalStep({ log }: StepContext) {
		log.info("Final step - should NOT run");
		return { final: true };
	}

	const cancelWorkflow = compileWorkflow(
		createWorkflow("cancelFlow").step(blockingStep).step(stepAfterBlock).step(finalStep).build(),
	);

	registry.register(cancelWorkflow);

	const registryActor = createRegistryActor(registry);

	const rivet = setup({
		use: {
			...registry.getAllActors(),
			workflowRegistry: registryActor,
		} as Parameters<typeof setup>[0]["use"],
	});

	const { client } = rivet.start({
		// Keep cancellation race test deterministic by running in a local memory runtime.
		driver: createMemoryDriver(),
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
			getRunStatus: (runId: string) => Promise<RunStatusInfo | undefined>;
			cancel: (runId: string) => Promise<{ success: boolean; error?: string }>;
		};
	};

	const instance = reg.getOrCreate("main");

	// Launch the workflow - step 1 will block on the barrier
	console.log("Launching cancelFlow...");
	const launchResult = await instance.launch("cancelFlow", {}, "cancel-run-1");
	if (launchResult.status !== "started") {
		throw new Error(`Expected 'started', got '${launchResult.status}'`);
	}

	// Give the workflow time to reach the blocking step
	await new Promise((resolve) => setTimeout(resolve, 50));

	// Cancel while step 1 is blocked
	console.log("Cancelling workflow while step 1 is blocked...");
	const cancelResult = await instance.cancel("cancel-run-1");
	console.log("Cancel result:", cancelResult);

	if (!cancelResult.success) {
		throw new Error(`Cancel should have succeeded, got error: ${cancelResult.error}`);
	}

	// Release the barrier so the blocking step can finish
	releaseBarrier();

	// Poll getRunStatus for cancelled status (live-query)
	const deadline = Date.now() + 5000;
	let finalStatus: RunStatusInfo | undefined;
	while (Date.now() < deadline) {
		finalStatus = await instance.getRunStatus("cancel-run-1");
		if (finalStatus && ["completed", "failed", "cancelled"].includes(finalStatus.status)) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	console.log("Final status:", finalStatus?.status);

	if (finalStatus?.status !== "cancelled") {
		throw new Error(`Expected 'cancelled', got '${finalStatus?.status}'`);
	}

	// Verify step results via coordinator directly
	// Querying coordinator state confirms orchestration-level behavior, not only registry metadata.
	const coordinatorType = (client as Record<string, unknown>).cancelFlow_coordinator as {
		getOrCreate: (id: string) => {
			getState: () => Promise<{
				status: string;
				stepResults: Record<string, unknown>;
			}>;
		};
	};

	const coordState = await coordinatorType.getOrCreate("cancel-run-1").getState();
	console.log("Coordinator status:", coordState.status);
	console.log("Step results keys:", Object.keys(coordState.stepResults));

	if (coordState.status !== "cancelled") {
		throw new Error(`Coordinator status should be 'cancelled', got '${coordState.status}'`);
	}

	// Only blockingStep should have a result (steps 2 and 3 should not have run)
	const resultKeys = Object.keys(coordState.stepResults);
	if (resultKeys.length !== 1 || resultKeys[0] !== "blockingStep") {
		throw new Error(`Expected only 'blockingStep' in results, got: ${resultKeys.join(", ")}`);
	}
	console.log("Correctly only blockingStep has results (steps 2 and 3 never ran)");

	console.log("\n[Cancellation tests passed]\n");
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

	try {
		results.cancellation = await testCancellation();
	} catch (e) {
		console.error("Cancellation test failed:", e);
		results.cancellation = false;
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
