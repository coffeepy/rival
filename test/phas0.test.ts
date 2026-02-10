/**
 * Real-World Workflow: "Who's slacking?" - Productivity Report
 *
 * Hits the real JSONPlaceholder API, fetches todos for all users,
 * ranks them by completion rate, and crowns the most productive.
 *
 *   fetchTodos → fetchUsers → crunchNumbers → generateReport
 *
 * Run with: bun test/phas0.test.ts
 */

import { type StepContext, createWorkflow, httpStep, rival } from "../src/rival";

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

type Todo = { userId: number; id: number; title: string; completed: boolean };
type User = { id: number; name: string; email: string; company: { name: string } };

// Step 1: Fetch all 200 todos from the API
const fetchTodos = httpStep({
	url: "https://jsonplaceholder.typicode.com/todos",
});

// Step 2: Fetch all 10 users
const fetchUsers = httpStep({
	url: "https://jsonplaceholder.typicode.com/users",
});

// Step 3: Crunch the numbers — group by user, compute completion rates
function crunchNumbers({ steps, log }: StepContext) {
	const todos = (steps.fetchTodos?.result as { data: Todo[] })?.data ?? [];
	const users = (steps.fetchUsers?.result as { data: User[] })?.data ?? [];

	log.info(`Processing ${todos.length} todos across ${users.length} users`);

	const byUser: Record<number, { total: number; done: number }> = {};
	for (const todo of todos) {
		if (!byUser[todo.userId]) byUser[todo.userId] = { total: 0, done: 0 };
		byUser[todo.userId].total++;
		if (todo.completed) byUser[todo.userId].done++;
	}

	const rankings = Object.entries(byUser)
		.map(([userId, stats]) => {
			const user = users.find((u) => u.id === Number(userId));
			return {
				userId: Number(userId),
				name: user?.name ?? `User ${userId}`,
				company: user?.company?.name ?? "Unknown",
				total: stats.total,
				done: stats.done,
				pending: stats.total - stats.done,
				rate: Math.round((stats.done / stats.total) * 100),
			};
		})
		.sort((a, b) => b.rate - a.rate);

	return { rankings, totalTodos: todos.length, totalUsers: users.length };
}

// Step 4: Generate a report
function generateReport({ steps, log, state }: StepContext) {
	const data = steps.crunchNumbers?.result as {
		rankings: {
			name: string;
			company: string;
			total: number;
			done: number;
			pending: number;
			rate: number;
		}[];
		totalTodos: number;
		totalUsers: number;
	};

	const { rankings } = data;
	const mvp = rankings[0];
	const slacker = rankings[rankings.length - 1];

	const lines = [
		"=== PRODUCTIVITY REPORT ===",
		"",
		`Analyzed ${data.totalTodos} todos across ${data.totalUsers} users`,
		"",
		"RANKINGS:",
		...rankings.map(
			(r, i) => `  ${i + 1}. ${r.name} (${r.company}) — ${r.rate}% done (${r.done}/${r.total})`,
		),
		"",
		`MVP: ${mvp.name} at ${mvp.rate}% completion`,
		`Needs coffee: ${slacker.name} at ${slacker.rate}% completion`,
	];

	const report = lines.join("\n");
	log.info("Report generated");
	state.description = `MVP: ${mvp.name} (${mvp.rate}%)`;

	return { report, mvp: mvp.name, slacker: slacker.name };
}

// Build the workflow
const workflow = createWorkflow("productivityReport")
	.description("Fetch todos from a real API and rank users by productivity")
	.step({ fn: fetchTodos, name: "fetchTodos" })
	.step({ fn: fetchUsers, name: "fetchUsers" })
	.step(crunchNumbers)
	.step(generateReport)
	.build();

// =============================================================================
// RUN IT
// =============================================================================

async function main() {
	console.log("\n============================================================");
	console.log("RIVAL: Who's Slacking? — Productivity Report Workflow");
	console.log("============================================================\n");

	const engine = rival(workflow);

	console.log(`Workflows: ${engine.list().join(", ")}`);
	console.log("Hitting jsonplaceholder.typicode.com...\n");

	const start = Date.now();
	const result = await engine.run("productivityReport");
	const elapsed = Date.now() - start;

	if (result.status !== "completed") {
		console.error(`FAILED: ${result.error}`);
		process.exit(1);
	}

	// Print the report
	const report = result.results?.generateReport?.result as {
		report: string;
		mvp: string;
		slacker: string;
	};
	console.log(report.report);
	console.log(`\nCompleted in ${elapsed}ms`);
	console.log("\nAll steps:");
	for (const [name, step] of Object.entries(result.results ?? {})) {
		console.log(`  ${step.status === "completed" ? "ok" : "FAIL"} ${name}`);
	}

	console.log("\nDone!\n");
	process.exit(0);
}

main().catch((err) => {
	console.error("\nFAILED:", err);
	process.exit(1);
});
