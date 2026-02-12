# Rival

A workflow engine library built on [RivetKit](https://rivet.gg). Define workflows in TypeScript, run them as stateful actors with automatic persistence.

## Quick Start

```typescript
import { rival, createWorkflow, type StepContext } from "rival";

// Define step functions
function fetchUser({ input, log }: StepContext) {
  log.info(`Fetching user ${input.userId}`);
  return { name: "Alice", email: "alice@example.com" };
}

function sendEmail({ steps, log }: StepContext) {
  const user = steps.fetchUser.result as { name: string; email: string };
  log.info(`Sending welcome email to ${user.email}`);
  return { sent: true };
}

// Build and run
const workflow = createWorkflow("onboarding")
  .step(fetchUser)
  .step(sendEmail)
  .build();

const engine = rival(workflow);
const { runId } = await engine.run("onboarding", { userId: "u-123" });
const result = await engine.wait("onboarding", runId);
console.log(result.status); // "completed"
```

## How It Works

Rival transforms your step functions into RivetKit actors at registration time. Each step becomes a stateful actor with its own execution state, retry logic, and logging. A coordinator actor orchestrates them sequentially according to the workflow plan.

```
Your functions  -->  rival()  -->  RivetKit actors  -->  engine.run() + engine.wait()
                     compiles       with persistence      start + await terminal state
```

## API

For a whole-system map of the app (builder, compiler, runtime, tests, and current known limitations), see:
`docs/app-overview.md`.

For a developer-oriented runtime walkthrough (current architecture, callback vs blocking paths, cancel semantics, and where to read code), see:
`docs/runtime-current-state.md`.

### `rival(...workflows)`

Top-level entry point. Accepts workflow definitions or pre-compiled workflows. Returns a `RivalEngine`.

```typescript
const engine = rival(workflow1, workflow2);

const { runId } = await engine.run("workflow1", { key: "value" }); // start by name
await engine.wait("workflow1", runId);                              // wait for terminal
engine.list();                                      // list workflow names
engine.get("workflow1");                            // get coordinator handle
```

`wait()` uses an event-first strategy and falls back to polling automatically.
You can tune behavior with `timeoutMs`, `pollIntervalMs`, `preferEvents`, and `eventWaitTimeoutMs`.

### `createWorkflow(name)`

Fluent builder for defining workflows.

```typescript
const workflow = createWorkflow("processOrder")
  .input(z.object({ orderId: z.string() }))   // optional Zod input validation
  .step(validateOrder)
  .step({ fn: processPayment, timeout: 30000, maxAttempts: 3 })
  .step(sendConfirmation)
  .build();
```

### `defineWorkflow(name, ...steps)`

Shorthand that builds and compiles in one call.

```typescript
const compiled = defineWorkflow("quick", stepA, stepB, stepC);
const engine = rival(compiled);
```

### Step Functions

Every step receives a `StepContext`:

```typescript
function myStep({ input, state, steps, lastStep, log }: StepContext) {
  log.info("Running step");

  // Access workflow input
  const data = input as { userId: string };

  // Access previous steps' results
  const prev = steps.previousStep?.result;

  // Set step state (persisted)
  state.description = "Processing user";

  // Return result (passed to next step)
  return { processed: true };
}
```

### Predefined Steps

```typescript
import { httpStep, delayStep } from "rival";

const fetchData = httpStep({
  url: "https://api.example.com/data",
  method: "GET",
});

const wait = delayStep({ duration: 1000 });
```

### Error Handling

Steps can throw `StepError` to control workflow behavior:

```typescript
import { StepError } from "rival";

function riskyStep({ log }: StepContext) {
  try {
    // ...
  } catch (err) {
    // "continue" lets the workflow proceed to the next step
    throw new StepError("Non-critical failure", { behavior: "continue" });
  }
}
```

Steps can also be configured with retries:

```typescript
createWorkflow("retryable")
  .step({ fn: flakyStep, maxAttempts: 5, backoff: "exponential" })
  .build();
```

## Running Tests

```bash
bun test
```

Test suites:
- `test/step-actors.test.ts` -- Core actors, retry, error handling
- `test/builder-compiler.test.ts` -- Builder API, compiler, defineWorkflow
- `test/predefined-steps.test.ts` -- httpStep, delayStep
- `test/engine.test.ts` -- `rival()` API, RivalEngine

## License

MIT
