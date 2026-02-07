/**
 * Phase 1 Test
 *
 * Tests the core Rival library functionality:
 * - createStepActor with function baked in
 * - createWorkflowCoordinator for orchestration
 * - Sequential step execution
 * - Retry behavior
 * - StepError handling
 *
 * Run with: bun test/phase1.test.ts
 */

import { setup } from "rivetkit";
import {
	type PlanNode,
	type StepContext,
	StepError,
	createStepActor,
	createWorkflowCoordinator,
} from "../src/rival";

// =============================================================================
// STEP FUNCTIONS
// =============================================================================

function findTree({ input, log }: StepContext<{ location: string }>) {
	log.info(`Searching in ${input.location}...`);
	return { treeId: "oak-123", species: "oak" };
}

function chopTree({ steps, log, state }: StepContext) {
	const tree = steps.findTree?.result as { treeId: string } | undefined;
	log.info(`Chopping tree ${tree?.treeId ?? "unknown"}...`);
	state.description = `Chopped ${tree?.treeId} into 10 pieces`;
	return { pieces: 10, chopped: true };
}

function processLumber({ steps, log }: StepContext) {
	const chop = steps.chopTree?.result as { pieces: number } | undefined;
	log.info(`Processing ${chop?.pieces ?? 0} pieces...`);
	return { product: "planks", quantity: (chop?.pieces ?? 0) * 4 };
}

function failingStep({ log }: StepContext) {
	log.error("This step always fails!");
	throw new Error("Intentional failure");
}

let flakyAttempts = 0;
function flakyStep({ log }: StepContext) {
	flakyAttempts++;
	log.info(`Attempt ${flakyAttempts}`);
	if (flakyAttempts < 3) {
		throw new Error(`Failed on attempt ${flakyAttempts}`);
	}
	return { success: true };
}

function skipStep({ state, log }: StepContext) {
	log.info("Checking if should skip...");
	state.skipped = true;
	state.description = "Skipped for testing";
	return null;
}

function stepErrorRetry({ log }: StepContext) {
	log.info("Throwing StepError with retry");
	throw new StepError("Retry me", {
		behavior: "retry",
		maxAttempts: 3,
		backoff: "exponential",
	});
}

// =============================================================================
// CREATE STEP ACTORS (functions baked in)
// =============================================================================

const findTreeStep = createStepActor(findTree);
const chopTreeStep = createStepActor(chopTree);
const processLumberStep = createStepActor(processLumber);
const failingStepActor = createStepActor(failingStep);
const flakyStepActor = createStepActor(flakyStep);
const skipStepActor = createStepActor(skipStep);
const stepErrorRetryActor = createStepActor(stepErrorRetry);

// =============================================================================
// CREATE WORKFLOW COORDINATORS
// =============================================================================

const happyPathPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorType: "findTreeStep" },
	{ type: "step", name: "chopTree", actorType: "chopTreeStep" },
	{ type: "step", name: "processLumber", actorType: "processLumberStep" },
];

const failurePlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorType: "findTreeStep" },
	{ type: "step", name: "failStep", actorType: "failingStepActor" },
	{ type: "step", name: "chopTree", actorType: "chopTreeStep" }, // Should not run
];

const retryPlan: PlanNode[] = [
	{ type: "step", name: "flakyStep", actorType: "flakyStepActor", config: { maxAttempts: 5 } },
];

const skipPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorType: "findTreeStep" },
	{ type: "step", name: "skipStep", actorType: "skipStepActor" },
	{ type: "step", name: "chopTree", actorType: "chopTreeStep" },
];

const happyPathCoordinator = createWorkflowCoordinator("happyPath", happyPathPlan);
const failureCoordinator = createWorkflowCoordinator("failure", failurePlan);
const retryCoordinator = createWorkflowCoordinator("retry", retryPlan);
const skipCoordinator = createWorkflowCoordinator("skip", skipPlan);

// =============================================================================
// REGISTER WITH RIVET
// =============================================================================

const registry = setup({
	use: {
		// Step actors
		findTreeStep,
		chopTreeStep,
		processLumberStep,
		failingStepActor,
		flakyStepActor,
		skipStepActor,
		stepErrorRetryActor,
		// Workflow coordinators
		happyPathCoordinator,
		failureCoordinator,
		retryCoordinator,
		skipCoordinator,
	},
});

// =============================================================================
// RUN TESTS
// =============================================================================

async function main() {
	console.log(`\n${"=".repeat(60)}`);
	console.log("RIVAL PHASE 1 TEST");
	console.log(`${"=".repeat(60)}\n`);

	const { client } = registry.start({
		disableDefaultServer: true,
		noWelcome: true,
	});

	// Test 1: Happy Path
	console.log("--- TEST 1: Happy Path ---\n");

	const wf1 = client.happyPathCoordinator.getOrCreate("test-happy");
	const result1 = await wf1.run("test-happy", { location: "forest-north" });

	console.log("\nResult:", JSON.stringify(result1, null, 2));
	console.log("---\n");

	// Test 2: Failure Handling
	console.log("--- TEST 2: Failure Handling ---\n");

	const wf2 = client.failureCoordinator.getOrCreate("test-fail");
	const result2 = await wf2.run("test-fail", { location: "forest-south" });

	console.log("\nResult:", JSON.stringify(result2, null, 2));
	console.log("---\n");

	// Test 3: Retry Behavior
	console.log("--- TEST 3: Retry Behavior ---\n");

	flakyAttempts = 0; // Reset
	const wf3 = client.retryCoordinator.getOrCreate("test-retry");
	const result3 = await wf3.run("test-retry", {});

	console.log("\nResult:", JSON.stringify(result3, null, 2));
	console.log("---\n");

	// Test 4: Skip Step
	console.log("--- TEST 4: Skip Step ---\n");

	const wf4 = client.skipCoordinator.getOrCreate("test-skip");
	const result4 = await wf4.run("test-skip", { location: "forest-east" });

	console.log("\nResult:", JSON.stringify(result4, null, 2));
	console.log("---\n");

	// Summary
	console.log("=".repeat(60));
	console.log("PHASE 1 TESTS COMPLETE");
	console.log("=".repeat(60));
	console.log("\nResults:");
	console.log(`  1. Happy Path:      ${result1.status}`);
	console.log(`  2. Failure:         ${result2.status} (expected: failed)`);
	console.log(`  3. Retry:           ${result3.status}`);
	console.log(`  4. Skip:            ${result4.status}`);

	const allPassed =
		result1.status === "completed" &&
		result2.status === "failed" &&
		result3.status === "completed" &&
		result4.status === "completed";

	console.log(`\n${allPassed ? "✓ All tests passed!" : "✗ Some tests failed"}\n`);

	process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
	console.error("\nTEST FAILED:", err);
	process.exit(1);
});
