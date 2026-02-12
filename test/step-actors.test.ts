/**
 * Step Actors Test
 *
 * Tests the core Rival library functionality:
 * - createStepActor with function baked in
 * - createWorkflowCoordinator for orchestration
 * - Sequential step execution
 * - Retry behavior
 * - StepError handling
 *
 * Run with: bun test/step-actors.test.ts
 */

import { setup } from "rivetkit";
import {
	type PlanNode,
	type StepContext,
	StepError,
	compileWorkflow,
	createStepActor,
	createWorkflow,
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

// =============================================================================
// CREATE WORKFLOW COORDINATORS
// =============================================================================

const happyPathPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorRef: "findTreeStep" },
	{ type: "step", name: "chopTree", actorRef: "chopTreeStep" },
	{ type: "step", name: "processLumber", actorRef: "processLumberStep" },
];

const failurePlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorRef: "findTreeStep" },
	{ type: "step", name: "failStep", actorRef: "failingStepActor" },
	{ type: "step", name: "chopTree", actorRef: "chopTreeStep" }, // Should not run
];

const retryPlan: PlanNode[] = [
	{ type: "step", name: "flakyStep", actorRef: "flakyStepActor", config: { maxAttempts: 5 } },
];

const skipPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorRef: "findTreeStep" },
	{ type: "step", name: "skipStep", actorRef: "skipStepActor" },
	{ type: "step", name: "chopTree", actorRef: "chopTreeStep" },
];

const continueOnErrorPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorRef: "findTreeStep" },
	{ type: "step", name: "continueStep", actorRef: "continueOnErrorStepActor" },
	{ type: "step", name: "checkStep", actorRef: "checkLastStepActor" },
];

const continueOnErrorLastPlan: PlanNode[] = [
	{ type: "step", name: "findTree", actorRef: "findTreeStep" },
	{ type: "step", name: "continueStep", actorRef: "continueOnErrorStepActor" },
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
		continueOnErrorStepActor,
		checkLastStepActor,
		// Workflow coordinators
		happyPathCoordinator,
		failureCoordinator,
		retryCoordinator,
		skipCoordinator,
		continueOnErrorCoordinator,
		continueOnErrorLastCoordinator,
	},
});

async function waitForTerminal(instance: {
	getState: () => Promise<{
		status: string;
		stepResults: Record<string, { status?: string; result?: unknown }>;
		error: string | null;
		failedStep: string | null;
	}>;
}): Promise<{
	status: string;
	results?: Record<string, { status?: string; result?: unknown }>;
	error?: string;
	failedStep?: string;
}> {
	for (;;) {
		const state = await instance.getState();
		if (state.status === "completed") {
			return { status: "completed", results: state.stepResults };
		}
		if (state.status === "failed") {
			return {
				status: "failed",
				error: state.error ?? undefined,
				failedStep: state.failedStep ?? undefined,
				results: state.stepResults,
			};
		}
		if (state.status === "cancelled") {
			return { status: "cancelled", results: state.stepResults };
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// =============================================================================
// RUN TESTS
// =============================================================================

async function main() {
	console.log(`\n${"=".repeat(60)}`);
	console.log("RIVAL TEST - Step Actors");
	console.log(`${"=".repeat(60)}\n`);

	const { client } = registry.start({
		disableDefaultServer: true,
		noWelcome: true,
	});
	const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	// Test 1: Happy Path
	console.log("--- TEST 1: Happy Path ---\n");

	const runId1 = `test-happy-${runSuffix}`;
	const wf1 = client.happyPathCoordinator.getOrCreate(runId1);
	await wf1.run(runId1, { location: "forest-north" });
	const result1 = await waitForTerminal(wf1);

	console.log("\nResult:", JSON.stringify(result1, null, 2));
	console.log("---\n");

	// Test 2: Failure Handling
	console.log("--- TEST 2: Failure Handling ---\n");

	const runId2 = `test-fail-${runSuffix}`;
	const wf2 = client.failureCoordinator.getOrCreate(runId2);
	await wf2.run(runId2, { location: "forest-south" });
	const result2 = await waitForTerminal(wf2);

	console.log("\nResult:", JSON.stringify(result2, null, 2));
	console.log("---\n");

	// Test 3: Retry Behavior
	console.log("--- TEST 3: Retry Behavior ---\n");

	flakyAttempts = 0; // Reset
	const runId3 = `test-retry-${runSuffix}`;
	const wf3 = client.retryCoordinator.getOrCreate(runId3);
	await wf3.run(runId3, {});
	const result3 = await waitForTerminal(wf3);

	console.log("\nResult:", JSON.stringify(result3, null, 2));
	console.log("---\n");

	// Test 4: Skip Step
	console.log("--- TEST 4: Skip Step ---\n");

	const runId4 = `test-skip-${runSuffix}`;
	const wf4 = client.skipCoordinator.getOrCreate(runId4);
	await wf4.run(runId4, { location: "forest-east" });
	const result4 = await waitForTerminal(wf4);

	console.log("\nResult:", JSON.stringify(result4, null, 2));
	console.log("---\n");

	// Test 5: Continue on Error (middle step)
	console.log("--- TEST 5: Continue on Error (middle step) ---\n");

	const runId5 = `test-continue-${runSuffix}`;
	const wf5 = client.continueOnErrorCoordinator.getOrCreate(runId5);
	await wf5.run(runId5, { location: "forest-west" });
	const result5 = await waitForTerminal(wf5);

	console.log("\nResult:", JSON.stringify(result5, null, 2));

	// Assertions for continue-on-error
	const t5_workflowCompleted = result5.status === "completed";
	const t5_step2Failed = result5.results?.continueStep?.status === "failed";
	const t5_step3Ran = result5.results?.checkStep != null;
	const t5_step3Result = result5.results?.checkStep?.result as
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

	const runId6 = `test-continue-last-${runSuffix}`;
	const wf6 = client.continueOnErrorLastCoordinator.getOrCreate(runId6);
	await wf6.run(runId6, { location: "forest-center" });
	const result6 = await waitForTerminal(wf6);

	console.log("\nResult:", JSON.stringify(result6, null, 2));

	const t6_workflowCompleted = result6.status === "completed";
	const t6_step2Failed = result6.results?.continueStep?.status === "failed";

	const wf6State = await wf6.getState();
	const t6_noError = wf6State.error === null;
	const t6_noFailedStep = wf6State.failedStep === null;

	const test6Passed = t6_workflowCompleted && t6_step2Failed && t6_noError && t6_noFailedStep;

	console.log(`  workflow completed:    ${t6_workflowCompleted}`);
	console.log(`  step2 failed:          ${t6_step2Failed}`);
	console.log(`  coordinator no error:  ${t6_noError}`);
	console.log(`  coordinator no failed: ${t6_noFailedStep}`);
	console.log("---\n");

	// Test 7, 8, 9: Duplicate step name detection (synchronous)
	const test7Passed = testBuilderRejectsDuplicateStepNames();
	const test8Passed = testCompilerRejectsDuplicateStepNames();
	const test9Passed = testCoordinatorRejectsDuplicateStepNames();

	// Summary
	console.log("=".repeat(60));
	console.log("STEP ACTORS TESTS COMPLETE");
	console.log("=".repeat(60));
	console.log("\nResults:");
	console.log(`  1. Happy Path:      ${result1.status}`);
	console.log(`  2. Failure:         ${result2.status} (expected: failed)`);
	console.log(`  3. Retry:           ${result3.status}`);
	console.log(`  4. Skip:            ${result4.status}`);
	console.log(`  5. Continue Error:  ${test5Passed ? "passed" : "FAILED"}`);
	console.log(`  6. Continue Last:   ${test6Passed ? "passed" : "FAILED"}`);
	console.log(`  7. Builder Dup:     ${test7Passed ? "passed" : "FAILED"}`);
	console.log(`  8. Compiler Dup:    ${test8Passed ? "passed" : "FAILED"}`);
	console.log(`  9. Coordinator Dup: ${test9Passed ? "passed" : "FAILED"}`);

	const allPassed =
		result1.status === "completed" &&
		result2.status === "failed" &&
		result3.status === "completed" &&
		result4.status === "completed" &&
		test5Passed &&
		test6Passed &&
		test7Passed &&
		test8Passed &&
		test9Passed;

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
			{ type: "step", name: "doWork", actorRef: "workStep" },
			{ type: "step", name: "doWork", actorRef: "workStep2" }, // duplicate name
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
