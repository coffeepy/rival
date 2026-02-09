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

import { createMemoryDriver, setup } from "rivetkit";
import {
	type PlanNode,
	type StepContext,
	StepError,
	compileWorkflow,
	createStepActor,
	createWorkflow,
	createWorkflowCoordinator,
} from "../src/rival";
import { waitForStatus } from "./helpers";

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

function slowStepForTimeout({ log }: StepContext) {
	log.info("Starting slow step (will exceed timeout)...");
	return new Promise((resolve) => {
		setTimeout(() => resolve({ done: true }), 500);
	});
}

function stepErrorRetry({ log }: StepContext) {
	log.info("Throwing StepError with retry");
	throw new StepError("Retry me", {
		behavior: "retry",
		maxAttempts: 3,
		backoff: "exponential",
	});
}

function continueOnErrorStep({ log }: StepContext) {
	log.info("Throwing StepError with continue");
	throw new StepError("Non-critical failure", { behavior: "continue" });
}

function checkLastStep({ steps, lastStep, log }: StepContext) {
	log.info(`lastStep points to: ${lastStep.stepName}`);
	return {
		lastStepName: lastStep.stepName,
		lastStepResult: lastStep.result,
		step2Status: steps.continueStep?.status,
	};
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
const continueOnErrorStepActor = createStepActor(continueOnErrorStep);
const checkLastStepActor = createStepActor(checkLastStep);
const slowStepForTimeoutActor = createStepActor(slowStepForTimeout);

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

const continueOnErrorPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorType: "findTreeStep" },
	{ type: "step", name: "continueStep", actorType: "continueOnErrorStepActor" },
	{ type: "step", name: "checkStep", actorType: "checkLastStepActor" },
];

const continueOnErrorLastPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorType: "findTreeStep" },
	{ type: "step", name: "continueStep", actorType: "continueOnErrorStepActor" },
];

const timeoutPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorType: "findTreeStep" },
	{
		type: "step",
		name: "slowStep",
		actorType: "slowStepForTimeoutActor",
		config: { timeout: 100 },
	},
	{ type: "step", name: "chopTree", actorType: "chopTreeStep" }, // Should not run
];

const happyPathCoordinator = createWorkflowCoordinator("happyPath", happyPathPlan);
const failureCoordinator = createWorkflowCoordinator("failure", failurePlan);
const retryCoordinator = createWorkflowCoordinator("retry", retryPlan);
const skipCoordinator = createWorkflowCoordinator("skip", skipPlan);
const continueOnErrorCoordinator = createWorkflowCoordinator(
	"continueOnError",
	continueOnErrorPlan,
);
const continueOnErrorLastCoordinator = createWorkflowCoordinator(
	"continueOnErrorLast",
	continueOnErrorLastPlan,
);
const timeoutCoordinator = createWorkflowCoordinator("timeout", timeoutPlan);

// =============================================================================
// REGISTER WITH RIVET
// =============================================================================

// This test registry mirrors how users wire Rival in a real app:
// 1) register reusable step actors
// 2) register one or more coordinator actors that reference those steps by type
// 3) call coordinator actions via a typed/untyped Rivet client handle
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
		continueOnErrorStepActor,
		checkLastStepActor,
		slowStepForTimeoutActor,
		// Workflow coordinators
		happyPathCoordinator,
		failureCoordinator,
		retryCoordinator,
		skipCoordinator,
		continueOnErrorCoordinator,
		continueOnErrorLastCoordinator,
		timeoutCoordinator,
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
		// Memory driver keeps test runs fast and isolated.
		// State persists only for this process lifetime (great for tests, not prod).
		driver: createMemoryDriver(),
		disableDefaultServer: true,
		noWelcome: true,
	});

	// Test 1: Happy Path
	console.log("--- TEST 1: Happy Path ---\n");

	const wf1 = client.happyPathCoordinator.getOrCreate("test-happy");
	// Actor key ("test-happy") is the durable identity for this coordinator instance.
	// Re-using the same key re-opens the same actor state.
	await wf1.start("test-happy", { location: "forest-north" });
	// start() is non-blocking orchestration kickoff. We poll state until terminal.
	const state1 = await waitForStatus(wf1);

	console.log(
		"\nResult:",
		JSON.stringify({ status: state1.status, results: state1.stepResults }, null, 2),
	);
	console.log("---\n");

	// Test 2: Failure Handling
	console.log("--- TEST 2: Failure Handling ---\n");

	const wf2 = client.failureCoordinator.getOrCreate("test-fail");
	await wf2.start("test-fail", { location: "forest-south" });
	const state2 = await waitForStatus(wf2);

	console.log("\nResult:", JSON.stringify({ status: state2.status, error: state2.error }, null, 2));
	console.log("---\n");

	// Test 3: Retry Behavior
	console.log("--- TEST 3: Retry Behavior ---\n");

	flakyAttempts = 0; // Reset
	const wf3 = client.retryCoordinator.getOrCreate("test-retry");
	await wf3.start("test-retry", {});
	const state3 = await waitForStatus(wf3);

	console.log(
		"\nResult:",
		JSON.stringify({ status: state3.status, results: state3.stepResults }, null, 2),
	);
	console.log("---\n");

	// Test 4: Skip Step
	console.log("--- TEST 4: Skip Step ---\n");

	const wf4 = client.skipCoordinator.getOrCreate("test-skip");
	await wf4.start("test-skip", { location: "forest-east" });
	const state4 = await waitForStatus(wf4);

	console.log(
		"\nResult:",
		JSON.stringify({ status: state4.status, results: state4.stepResults }, null, 2),
	);
	console.log("---\n");

	// Test 5: Continue on Error (middle step)
	console.log("--- TEST 5: Continue on Error (middle step) ---\n");

	const wf5 = client.continueOnErrorCoordinator.getOrCreate("test-continue");
	await wf5.start("test-continue", { location: "forest-west" });
	const state5 = await waitForStatus(wf5);

	console.log(
		"\nResult:",
		JSON.stringify({ status: state5.status, results: state5.stepResults }, null, 2),
	);

	// Assertions for continue-on-error
	const t5_workflowCompleted = state5.status === "completed";
	const t5_step2Failed = state5.stepResults?.continueStep?.status === "failed";
	const t5_step3Ran = state5.stepResults?.checkStep != null;
	const t5_step3Result = state5.stepResults?.checkStep?.result as
		| {
				lastStepName: string;
				step2Status: string;
		  }
		| undefined;
	const t5_lastStepPointsToStep2 = t5_step3Result?.lastStepName === "continueStep";
	const t5_step2StatusVisible = t5_step3Result?.step2Status === "failed";

	// Check coordinator state is healthy
	const wf5State = await wf5.getState();
	const t5_noError = wf5State.error === null;
	const t5_noFailedStep = wf5State.failedStep === null;

	const test5Passed =
		t5_workflowCompleted &&
		t5_step2Failed &&
		t5_step3Ran &&
		t5_lastStepPointsToStep2 &&
		t5_step2StatusVisible &&
		t5_noError &&
		t5_noFailedStep;

	console.log(`  workflow completed:    ${t5_workflowCompleted}`);
	console.log(`  step2 failed:          ${t5_step2Failed}`);
	console.log(`  step3 ran:             ${t5_step3Ran}`);
	console.log(`  lastStep -> step2:     ${t5_lastStepPointsToStep2}`);
	console.log(`  step2 status visible:  ${t5_step2StatusVisible}`);
	console.log(`  coordinator no error:  ${t5_noError}`);
	console.log(`  coordinator no failed: ${t5_noFailedStep}`);
	console.log("---\n");

	// Test 6: Continue on Error (last step)
	console.log("--- TEST 6: Continue on Error (last step) ---\n");

	const wf6 = client.continueOnErrorLastCoordinator.getOrCreate("test-continue-last");
	await wf6.start("test-continue-last", { location: "forest-center" });
	const state6 = await waitForStatus(wf6);

	console.log(
		"\nResult:",
		JSON.stringify({ status: state6.status, results: state6.stepResults }, null, 2),
	);

	const t6_workflowCompleted = state6.status === "completed";
	const t6_step2Failed = state6.stepResults?.continueStep?.status === "failed";

	const wf6State = await wf6.getState();
	const t6_noError = wf6State.error === null;
	const t6_noFailedStep = wf6State.failedStep === null;

	const test6Passed = t6_workflowCompleted && t6_step2Failed && t6_noError && t6_noFailedStep;

	console.log(`  workflow completed:    ${t6_workflowCompleted}`);
	console.log(`  step2 failed:          ${t6_step2Failed}`);
	console.log(`  coordinator no error:  ${t6_noError}`);
	console.log(`  coordinator no failed: ${t6_noFailedStep}`);
	console.log("---\n");

	// Test 10: Step Timeout (per-step config.timeout)
	console.log("--- TEST 10: Step Timeout ---\n");

	const wf10 = client.timeoutCoordinator.getOrCreate("test-timeout");
	await wf10.start("test-timeout", { location: "forest-timeout" });
	const state10 = await waitForStatus(wf10);

	const t10_failed = state10.status === "failed";
	const t10_failedStep = state10.failedStep === "slowStep";
	const t10_errorMsg =
		typeof state10.error === "string" && state10.error.includes("timed out after 100ms");
	const t10_firstStepRan = state10.stepResults?.findTree != null;
	const t10_lastStepSkipped = state10.stepResults?.chopTree == null;
	const test10Passed =
		t10_failed && t10_failedStep && t10_errorMsg && t10_firstStepRan && t10_lastStepSkipped;

	console.log(`  status:         ${state10.status}`);
	console.log(`  failedStep:     ${state10.failedStep}`);
	console.log(`  error:          ${state10.error}`);
	console.log(`  findTree ran:   ${t10_firstStepRan}`);
	console.log(`  chopTree skip:  ${t10_lastStepSkipped}`);
	console.log(`  ${test10Passed ? "passed" : "FAILED"}`);
	console.log("---\n");

	// Test 7, 8, 9: Duplicate step name detection (synchronous)
	const test7Passed = testBuilderRejectsDuplicateStepNames();
	const test8Passed = testCompilerRejectsDuplicateStepNames();
	const test9Passed = testCoordinatorRejectsDuplicateStepNames();

	// Summary
	console.log("=".repeat(60));
	console.log("PHASE 1 TESTS COMPLETE");
	console.log("=".repeat(60));
	console.log("\nResults:");
	console.log(`  1. Happy Path:      ${state1.status}`);
	console.log(`  2. Failure:         ${state2.status} (expected: failed)`);
	console.log(`  3. Retry:           ${state3.status}`);
	console.log(`  4. Skip:            ${state4.status}`);
	console.log(`  5. Continue Error:  ${test5Passed ? "passed" : "FAILED"}`);
	console.log(`  6. Continue Last:   ${test6Passed ? "passed" : "FAILED"}`);
	console.log(`  7. Builder Dup:     ${test7Passed ? "passed" : "FAILED"}`);
	console.log(`  8. Compiler Dup:    ${test8Passed ? "passed" : "FAILED"}`);
	console.log(`  9. Coordinator Dup: ${test9Passed ? "passed" : "FAILED"}`);
	console.log(`  10. Step Timeout:   ${test10Passed ? "passed" : "FAILED"}`);

	const allPassed =
		state1.status === "completed" &&
		state2.status === "failed" &&
		state3.status === "completed" &&
		state4.status === "completed" &&
		test5Passed &&
		test6Passed &&
		test7Passed &&
		test8Passed &&
		test9Passed &&
		test10Passed;

	console.log(`\n${allPassed ? "✓ All tests passed!" : "✗ Some tests failed"}\n`);

	process.exit(allPassed ? 0 : 1);
}

// =============================================================================
// DUPLICATE STEP NAME TESTS (synchronous, no runtime needed)
// =============================================================================

function testBuilderRejectsDuplicateStepNames(): boolean {
	console.log("--- TEST 7: Builder rejects duplicate step names ---\n");
	try {
		createWorkflow("dupTest")
			.step(chopTree)
			.step(chopTree) // same function = same derived name
			.build();
		console.log("  FAILED: expected error was not thrown");
		return false;
	} catch (err) {
		const msg = (err as Error).message;
		const passed = msg.includes('already has a step named "chopTree"');
		console.log(`  Error: ${msg}`);
		console.log(`  ${passed ? "passed" : "FAILED"}`);
		console.log("---\n");
		return passed;
	}
}

function testCoordinatorRejectsDuplicateStepNames(): boolean {
	console.log("--- TEST 9: Coordinator rejects duplicate step names (Zod) ---\n");
	try {
		createWorkflowCoordinator("dupCoord", [
			{ type: "step", name: "doWork", actorType: "workStep" },
			{ type: "step", name: "doWork", actorType: "workStep2" }, // duplicate name
		]);
		console.log("  FAILED: expected error was not thrown");
		return false;
	} catch (err) {
		const msg = (err as Error).message;
		const passed = msg.includes('Duplicate step name "doWork"');
		console.log(`  Error: ${msg}`);
		console.log(`  ${passed ? "passed" : "FAILED"}`);
		console.log("---\n");
		return passed;
	}
}

function testCompilerRejectsDuplicateStepNames(): boolean {
	console.log("--- TEST 8: Compiler rejects duplicate step names ---\n");
	try {
		compileWorkflow({
			name: "dupCompile",
			steps: [
				{ fn: chopTree, name: "sharedName" },
				{ fn: processLumber, name: "sharedName" }, // duplicate name
			],
		});
		console.log("  FAILED: expected error was not thrown");
		return false;
	} catch (err) {
		const msg = (err as Error).message;
		const passed = msg.includes('has duplicate step name "sharedName"');
		console.log(`  Error: ${msg}`);
		console.log(`  ${passed ? "passed" : "FAILED"}`);
		console.log("---\n");
		return passed;
	}
}

main().catch((err) => {
	console.error("\nTEST FAILED:", err);
	process.exit(1);
});
