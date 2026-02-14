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
  .description("Process a customer order")      // optional description
  .step(validateOrder)
  .step({ run: processPayment, timeout: 30000, maxAttempts: 3 })
  .step(sendConfirmation)
  .build();
```

### `createWorkflow(name).forEach(config)`

Add a forEach loop to iterate over items.

```typescript
const workflow = createWorkflow("processItems")
  .forEach({
    items: ({ input }) => input.items,       // returns array to iterate
    run: processItem,                        // step function for each item
    parallel: true,                          // run iterations concurrently
    concurrency: 5,                          // max in-flight iterations
  })
  .build();
```

### `createWorkflow(name).concurrent(config)`

Run multiple child steps/workflows concurrently and join results into one step result.

```typescript
const workflow = createWorkflow("setupUser")
  .concurrent({
    alias: "setup",
    onFailure: "collect", // "fail" (default) | "collect"
    steps: [
      { alias: "db", run: createDbUser },
      { alias: "crm", run: createCrmProfile },
    ],
  })
  .step(({ steps }) => {
    const setup = steps.setup?.result as Record<string, { status: string; result: unknown }>;
    return { db: setup.db?.status, crm: setup.crm?.status };
  })
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
function myStep({ input, state, steps, lastStep, log, loop }: StepContext) {
  log.info("Running step");

  // Access workflow input
  const data = input as { userId: string };

  // Access previous steps' results
  const prev = steps.previousStep?.result;

  // Set step state (persisted)
  state.description = "Processing user";

  // Access loop context (when inside forEach)
  if (loop) {
    console.log(`Processing item ${loop.index}:`, loop.item);
  }

  // Return result (passed to next step)
  return { processed: true };
}
```

### Step Configuration

Steps can be configured with additional options:

```typescript
createWorkflow("configurable")
  .step({
    run: myStep,
    timeout: 30000,           // timeout in ms
    maxAttempts: 3,           // retry attempts
    backoff: "exponential",    // or "linear"
    onTimeout: "retry",       // "stop" or "retry" on timeout
    actor: { options: { actionTimeout: 35000 } },  // Rivet actor escape hatch
    onError: (ctx) => { console.error(ctx.error); }
  })
  .build();
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
  .step({ run: flakyStep, maxAttempts: 5, backoff: "exponential" })
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
- `test/foreach-loop.test.ts` -- forEach loops, parallel iterations, nesting
- `test/concurrent-block.test.ts` -- Concurrent blocks (`concurrent`) and failure modes
- `test/step-actor-scheduling.test.ts` -- Scheduled retry/timeout behavior
- `test/timeout-actor-options.test.ts` -- Timeout/action options integration

## License

MIT

## Current Limitations

Rival is actively developed. See `ROADMAP.md` for a detailed list of planned features not yet implemented, including:
- Branching (if/else)
- Subworkflow calls
- Checkpoints & recovery
- Human-in-the-loop tasks
