/**
 * Predefined Steps Test
 *
 * Tests the predefined step factories:
 * - httpStep
 * - delayStep
 *
 * Run with: bun test/predefined-steps.test.ts
 */

import { createFileSystemDriver, setup } from "rivetkit";
import {
	type StepContext,
	compileWorkflow,
	createWorkflow,
	delayStep,
	httpStep,
} from "../src/rival";
import { waitForTerminal } from "./helpers/wait-for-terminal";

// =============================================================================
// TEST: DELAY STEP
// =============================================================================

async function testDelayStep() {
	console.log("--- TEST: Delay Step ---\n");

	// Test 1: Fixed delay in milliseconds
	const shortDelay = delayStep({ milliseconds: 50 });

	const mockContext: StepContext = {
		input: {},
		state: {},
		steps: {},
		lastStep: { result: undefined, state: {}, stepName: null },
		log: {
			debug: () => {},
			info: (msg: string | object) =>
				console.log(`  [info] ${typeof msg === "string" ? msg : JSON.stringify(msg)}`),
			warn: () => {},
			error: () => {},
		},
	};

	console.log("Testing 50ms delay...");
	const start = Date.now();
	const result = await shortDelay(mockContext);
	const elapsed = Date.now() - start;

	console.log(`  Result: delayed ${result.delayedMs}ms (elapsed: ${elapsed}ms)`);

	if (result.delayedMs < 45 || result.delayedMs > 100) {
		throw new Error(`Unexpected delay: ${result.delayedMs}ms`);
	}

	// Test 2: Fixed delay in seconds
	const secondDelay = delayStep({ seconds: 0.1 });
	console.log("\nTesting 0.1s delay...");
	const result2 = await secondDelay(mockContext);
	console.log(`  Result: delayed ${result2.delayedMs}ms`);

	if (result2.delayedMs < 90 || result2.delayedMs > 150) {
		throw new Error(`Unexpected delay: ${result2.delayedMs}ms`);
	}

	// Test 3: Dynamic delay from context
	const dynamicDelay = delayStep({
		milliseconds: ({ input }) => (input as { waitMs: number }).waitMs,
	});

	const dynamicContext: StepContext = {
		...mockContext,
		input: { waitMs: 30 },
	};

	console.log("\nTesting dynamic delay (30ms from input)...");
	const result3 = await dynamicDelay(dynamicContext);
	console.log(`  Result: delayed ${result3.delayedMs}ms`);

	// Test 4: Zero delay
	const zeroDelay = delayStep({ milliseconds: 0 });
	console.log("\nTesting zero delay...");
	const result4 = await zeroDelay(mockContext);
	console.log(`  Result: delayed ${result4.delayedMs}ms`);

	if (result4.delayedMs !== 0) {
		throw new Error(`Expected 0ms delay, got ${result4.delayedMs}ms`);
	}

	console.log("\n[Delay Step tests passed]\n");
	return true;
}

// =============================================================================
// TEST: HTTP STEP (with mock server)
// =============================================================================

async function testHttpStep() {
	console.log("--- TEST: HTTP Step ---\n");

	// Start a simple mock server
	const server = Bun.serve({
		port: 0, // Random available port
		fetch(req) {
			const url = new URL(req.url);

			if (url.pathname === "/users" && req.method === "GET") {
				return Response.json([
					{ id: 1, name: "Alice" },
					{ id: 2, name: "Bob" },
				]);
			}

			if (url.pathname === "/users" && req.method === "POST") {
				return req
					.json()
					.then((body) =>
						Response.json({ id: 3, ...(body as Record<string, unknown>) }, { status: 201 }),
					);
			}

			if (url.pathname.startsWith("/users/")) {
				const id = url.pathname.split("/")[2];
				return Response.json({ id: Number(id), name: `User ${id}` });
			}

			if (url.pathname === "/error") {
				return new Response("Not Found", { status: 404 });
			}

			if (url.pathname === "/slow") {
				return new Promise((resolve) => {
					setTimeout(() => resolve(Response.json({ slow: true })), 100);
				});
			}

			return new Response("Not Found", { status: 404 });
		},
	});

	const baseUrl = `http://localhost:${server.port}`;

	try {
		const mockContext: StepContext = {
			input: { userId: 42 },
			state: {},
			steps: {},
			lastStep: { result: undefined, state: {}, stepName: null },
			log: {
				debug: () => {},
				info: (msg: string | object) =>
					console.log(`  [info] ${typeof msg === "string" ? msg : JSON.stringify(msg)}`),
				warn: () => {},
				error: (msg: string | object) =>
					console.log(`  [error] ${typeof msg === "string" ? msg : JSON.stringify(msg)}`),
			},
		};

		// Test 1: Simple GET
		console.log("Testing GET /users...");
		const getUsers = httpStep({ url: `${baseUrl}/users` });
		const result1 = await getUsers(mockContext);
		console.log(`  Status: ${result1.status}, Data: ${JSON.stringify(result1.data)}`);

		if (result1.status !== 200 || !Array.isArray(result1.data)) {
			throw new Error("GET /users failed");
		}

		// Test 2: Dynamic URL
		console.log("\nTesting GET /users/:id with dynamic URL...");
		const getUser = httpStep({
			url: ({ input }) => `${baseUrl}/users/${(input as { userId: number }).userId}`,
		});
		const result2 = await getUser(mockContext);
		console.log(`  Status: ${result2.status}, Data: ${JSON.stringify(result2.data)}`);

		if (result2.status !== 200) {
			throw new Error("GET /users/:id failed");
		}

		// Test 3: POST with body
		console.log("\nTesting POST /users with body...");
		const createUser = httpStep({
			url: `${baseUrl}/users`,
			method: "POST",
			body: { name: "Charlie", email: "charlie@example.com" },
		});
		const result3 = await createUser(mockContext);
		console.log(`  Status: ${result3.status}, Data: ${JSON.stringify(result3.data)}`);

		if (result3.status !== 201) {
			throw new Error("POST /users failed");
		}

		// Test 4: Error handling (throwOnError: false)
		console.log("\nTesting error handling (404, throwOnError: false)...");
		const getError = httpStep({
			url: `${baseUrl}/error`,
			throwOnError: false,
		});
		const result4 = await getError(mockContext);
		console.log(`  Status: ${result4.status}`);

		if (result4.status !== 404) {
			throw new Error("Expected 404 status");
		}

		// Test 5: Error handling (throwOnError: true)
		console.log("\nTesting error handling (404, throwOnError: true)...");
		const getErrorThrow = httpStep({
			url: `${baseUrl}/error`,
			throwOnError: true,
		});

		try {
			await getErrorThrow(mockContext);
			throw new Error("Should have thrown");
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("404")) {
				throw err;
			}
			console.log(`  Correctly threw: ${err.message}`);
		}

		// Test 6: Response includes duration
		console.log("\nTesting duration tracking...");
		const slowRequest = httpStep({
			url: `${baseUrl}/slow`,
		});
		const result6 = await slowRequest(mockContext);
		console.log(`  Duration: ${result6.duration}ms`);

		if (result6.duration < 50) {
			throw new Error(`Expected duration >= 50ms, got ${result6.duration}ms`);
		}

		console.log("\n[HTTP Step tests passed]\n");
		return true;
	} finally {
		server.stop();
	}
}

// =============================================================================
// TEST: INTEGRATION WITH WORKFLOW
// =============================================================================

async function testWorkflowIntegration() {
	console.log("--- TEST: Workflow Integration ---\n");

	// Start mock server
	const server = Bun.serve({
		port: 0,
		fetch() {
			return Response.json({ message: "Hello from API" });
		},
	});

	const baseUrl = `http://localhost:${server.port}`;

	try {
		// Create a workflow using predefined steps
		const workflow = createWorkflow("apiWorkflow")
			.step(function logStart({ log }: StepContext) {
				log.info("Starting API workflow");
				return { started: true };
			})
			.step(httpStep({ url: `${baseUrl}/` }))
			.step(delayStep({ milliseconds: 50 }))
			.step(function logEnd({ steps, log }: StepContext) {
				const httpResult = steps.httpRequest?.result as { data: unknown } | undefined;
				log.info("Workflow complete");
				return { apiData: httpResult?.data };
			})
			.build();

		const compiled = compileWorkflow(workflow);

		console.log("Compiled workflow:");
		console.log(`  Steps: ${compiled.plan.map((n) => n.name).join(" → ")}`);

		// Register and run
		const registry = setup({
			use: compiled.actors as Parameters<typeof setup>[0]["use"],
		});

		const { client } = registry.start({
			driver: createFileSystemDriver({
				path: `/tmp/rival-test-predefined-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			}),
			disableDefaultServer: true,
			noWelcome: true,
		});

		const coordinator = (client as Record<string, unknown>)[compiled.coordinatorActorRef] as {
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

		console.log("\nRunning workflow...");
		const runId = `test-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const instance = coordinator.getOrCreate(runId);
		await instance.run(runId, {});
		const result = await waitForTerminal(instance);

		console.log(`\nResult: ${result.status}`);

		if (result.status !== "completed") {
			throw new Error(`Expected completed, got ${result.status}`);
		}

		console.log("\n[Workflow Integration tests passed]\n");
		return true;
	} finally {
		server.stop();
	}
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

async function main() {
	console.log(`\n${"=".repeat(60)}`);
	console.log("RIVAL TEST - Predefined Steps");
	console.log(`${"=".repeat(60)}\n`);

	const results: Record<string, boolean> = {};

	try {
		results.delayStep = await testDelayStep();
	} catch (e) {
		console.error("Delay Step test failed:", e);
		results.delayStep = false;
	}

	try {
		results.httpStep = await testHttpStep();
	} catch (e) {
		console.error("HTTP Step test failed:", e);
		results.httpStep = false;
	}

	try {
		results.workflowIntegration = await testWorkflowIntegration();
	} catch (e) {
		console.error("Workflow Integration test failed:", e);
		results.workflowIntegration = false;
	}

	// Summary
	console.log("=".repeat(60));
	console.log("PREDEFINED STEPS TESTS COMPLETE");
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
