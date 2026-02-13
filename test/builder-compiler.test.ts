/**
 * Builder & Compiler Test
 *
 * Tests the builder and compiler functionality:
 * - createWorkflow fluent API
 * - compileWorkflow transformation
 * - Generated actors work correctly
 * - Full workflow execution with compiled workflow
 *
 * Run with: bun test/builder-compiler.test.ts
 */

import { createFileSystemDriver, setup } from "rivetkit";
import { z } from "zod";
import { type StepContext, compileWorkflow, createWorkflow, defineWorkflow } from "../src/rival";
import { waitForTerminal } from "./helpers/wait-for-terminal";

// =============================================================================
// STEP FUNCTIONS
// =============================================================================

interface OrderInput {
	orderId: string;
	amount: number;
}

function validateInput({ input, log }: StepContext) {
	const orderInput = input as OrderInput;
	log.info(`Validating order ${orderInput.orderId}`);
	if (orderInput.amount <= 0) {
		throw new Error("Amount must be positive");
	}
	return { valid: true, orderId: orderInput.orderId };
}

function processPayment({ input, steps, log }: StepContext) {
	const orderInput = input as OrderInput;
	const validation = steps.validateInput?.result as { orderId: string } | undefined;
	log.info(`Processing payment for order ${validation?.orderId ?? orderInput.orderId}`);
	return { transactionId: "txn-12345", amount: orderInput.amount };
}

function sendConfirmation({ steps, log }: StepContext) {
	const payment = steps.processPayment?.result as { transactionId: string } | undefined;
	log.info(`Sending confirmation for ${payment?.transactionId}`);
	return { emailSent: true, transactionId: payment?.transactionId };
}

// =============================================================================
// TEST: WORKFLOW BUILDER
// =============================================================================

async function testBuilder() {
	console.log("--- TEST: Workflow Builder ---\n");

	// Test 1: Simple workflow
	const simpleWorkflow = createWorkflow("simple").step(validateInput).build();

	console.log("Simple workflow:");
	console.log(`  Name: ${simpleWorkflow.name}`);
	console.log(`  Steps: ${simpleWorkflow.steps.length}`);
	console.log(`  Step aliases: ${simpleWorkflow.steps.map((s) => s.alias).join(", ")}`);

	if (simpleWorkflow.name !== "simple" || simpleWorkflow.steps.length !== 1) {
		throw new Error("Simple workflow test failed");
	}

	// Test 2: Workflow with input schema
	const inputSchema = z.object({
		orderId: z.string(),
		amount: z.number().positive(),
	});

	const orderWorkflow = createWorkflow("processOrder")
		.input(inputSchema)
		.description("Process a customer order")
		.step(validateInput)
		.step({ run: processPayment, timeout: 30000, maxAttempts: 3 })
		.step(sendConfirmation)
		.build();

	console.log("\nOrder workflow:");
	console.log(`  Name: ${orderWorkflow.name}`);
	console.log(`  Description: ${orderWorkflow.description}`);
	console.log(`  Has input schema: ${orderWorkflow.inputSchema !== undefined}`);
	console.log(`  Steps: ${orderWorkflow.steps.length}`);

	for (const step of orderWorkflow.steps) {
		const config = "config" in step ? step.config : undefined;
		console.log(`    - ${step.alias}${config ? ` (config: ${JSON.stringify(config)})` : ""}`);
	}

	if (orderWorkflow.steps.length !== 3 || !orderWorkflow.inputSchema) {
		throw new Error("Order workflow test failed");
	}

	// Verify step config was applied
	const paymentStep = orderWorkflow.steps.find((s) => s.alias === "processPayment");
	const paymentConfig = paymentStep && "config" in paymentStep ? paymentStep.config : undefined;
	if (!paymentConfig?.timeout || paymentConfig.timeout !== 30000) {
		throw new Error("Step config not applied correctly");
	}

	console.log("\n[Builder tests passed]\n");
	return true;
}

// =============================================================================
// TEST: COMPILER
// =============================================================================

async function testCompiler() {
	console.log("--- TEST: Compiler ---\n");

	const inputSchema = z.object({
		orderId: z.string(),
		amount: z.number().positive(),
	});

	const definition = createWorkflow("orderFlow")
		.input(inputSchema)
		.step(validateInput)
		.step(processPayment)
		.step(sendConfirmation)
		.build();

	const compiled = compileWorkflow(definition);

	console.log("Compiled workflow:");
	console.log(`  Name: ${compiled.name}`);
	console.log(`  Coordinator: ${compiled.coordinatorActorRef}`);
	console.log(`  Actor count: ${Object.keys(compiled.actors).length}`);
	console.log(`  Actor refs: ${Object.keys(compiled.actors).join(", ")}`);
	console.log(`  Plan nodes: ${compiled.plan.length}`);

	for (const node of compiled.plan) {
		if (node.type === "step") {
			console.log(`    - ${node.alias} -> ${node.actorRef}`);
		}
	}

	// Verify correct actor naming
	const expectedActors = [
		"orderFlow_validateInput",
		"orderFlow_processPayment",
		"orderFlow_sendConfirmation",
		"orderFlow_coordinator",
	];

	for (const expected of expectedActors) {
		if (!(expected in compiled.actors)) {
			throw new Error(`Missing expected actor: ${expected}`);
		}
	}

	// Verify plan references correct actor refs
	for (const node of compiled.plan) {
		if (node.type === "step") {
			const expectedActorRef = `orderFlow_${node.alias}`;
			if (node.actorRef !== expectedActorRef) {
				throw new Error(`Plan node ${node.alias} has wrong actorRef: ${node.actorRef}`);
			}
		}
	}

	console.log("\n[Compiler tests passed]\n");
	return true;
}

// =============================================================================
// TEST: FULL EXECUTION WITH COMPILED WORKFLOW
// =============================================================================

async function testExecution() {
	console.log("--- TEST: Full Execution ---\n");

	const inputSchema = z.object({
		orderId: z.string(),
		amount: z.number().positive(),
	});

	const compiled = createWorkflow("orderExec")
		.input(inputSchema)
		.step(validateInput)
		.step(processPayment)
		.step(sendConfirmation)
		.build();

	const compiledWorkflow = compileWorkflow(compiled);

	// Register with RivetKit
	const registry = setup({
		use: compiledWorkflow.actors as Parameters<typeof setup>[0]["use"],
	});

	const { client } = registry.start({
		driver: createFileSystemDriver({
			path: `/tmp/rival-test-builder-compiler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		}),
		disableDefaultServer: true,
		noWelcome: true,
	});

	// Get the coordinator and run the workflow
	const coordinator = (client as Record<string, unknown>)[compiledWorkflow.coordinatorActorRef] as {
		getOrCreate: (id: string) => {
			run: (
				id: string,
				input: unknown,
			) => Promise<{ status: string; results?: Record<string, unknown> }>;
			getState: () => Promise<{
				status: string;
				stepResults: Record<string, unknown>;
				error: string | null;
			}>;
		};
	};

	const runId = `test-order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const instance = coordinator.getOrCreate(runId);
	await instance.run(runId, {
		orderId: "ORD-123",
		amount: 99.99,
	});
	const result = await waitForTerminal(instance);

	console.log("Execution result:");
	console.log(JSON.stringify(result, null, 2));

	if (result.status !== "completed") {
		throw new Error(`Expected completed, got ${result.status}`);
	}

	// Verify all steps executed
	const expectedSteps = ["validateInput", "processPayment", "sendConfirmation"];
	for (const step of expectedSteps) {
		if (!result.results?.[step]) {
			throw new Error(`Missing result for step: ${step}`);
		}
	}

	console.log("\n[Execution tests passed]\n");
	return true;
}

// =============================================================================
// TEST: DEFINE WORKFLOW SHORTHAND
// =============================================================================

async function testDefineWorkflow() {
	console.log("--- TEST: defineWorkflow Shorthand ---\n");

	const compiled = defineWorkflow("quickFlow", {
		steps: [
			{ id: "s1", alias: "validate", run: validateInput },
			{ id: "s2", alias: "pay", run: processPayment },
		],
		inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
	});

	console.log("Quick workflow:");
	console.log(`  Name: ${compiled.name}`);
	console.log(`  Actors: ${Object.keys(compiled.actors).join(", ")}`);

	if (!compiled.actors.quickFlow_validate || !compiled.actors.quickFlow_pay) {
		throw new Error("defineWorkflow did not create expected actors");
	}

	console.log("\n[defineWorkflow tests passed]\n");
	return true;
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

async function main() {
	console.log(`\n${"=".repeat(60)}`);
	console.log("RIVAL TEST - Builder & Compiler");
	console.log(`${"=".repeat(60)}\n`);

	const results: Record<string, boolean> = {};

	try {
		results.builder = await testBuilder();
	} catch (e) {
		console.error("Builder test failed:", e);
		results.builder = false;
	}

	try {
		results.compiler = await testCompiler();
	} catch (e) {
		console.error("Compiler test failed:", e);
		results.compiler = false;
	}

	try {
		results.execution = await testExecution();
	} catch (e) {
		console.error("Execution test failed:", e);
		results.execution = false;
	}

	try {
		results.defineWorkflow = await testDefineWorkflow();
	} catch (e) {
		console.error("defineWorkflow test failed:", e);
		results.defineWorkflow = false;
	}

	// Summary
	console.log("=".repeat(60));
	console.log("BUILDER & COMPILER TESTS COMPLETE");
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
