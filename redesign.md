# Rival Redesign Specification

## Problem Statement

Currently, steps are defined on the frontend. The redesign aims to make steps and workflows easy for developers to create and launch from the backend. This shift will improve developer experience and enable better workflow management.

## Core Design Principles

### 1. Backend-First Workflow Creation

Workflows should be created in TypeScript on the backend:
- Workflows launch steps in order and track the status of each step
- Workflows track results of steps
- Developers should be able to easily create and register workflows

### 2. Backend Step Definition

Steps should be created on the backend as functions with special properties:
- Steps are just functions, but there are special props we pass in
- Step IDs are just their function name for simplicity
- Steps should be retryable, idempotent, and atomic (up to user, but retry functionality should be built in)

## Step Design

### Step Function Signature

**Functions are passed uninitiated** (not called) to the workflow. The workflow orchestrator calls each function with a context object as the first argument.

By default, step functions receive **context as their first argument**:

```typescript
function findTree(context) {
    // Access context properties
    console.log('finding tree')
    return tree
}
```

### Context Injection and Destructuring

Functions can destructure the context to access only what they need:

```typescript
// Destructure specific properties
function findTree({ lastStep, steps }) {
    // Use lastStep and steps
    console.log('finding tree')
    return tree
}

// Or use spread syntax to get everything
function findTree(context) {
    const { lastStep, steps, ...rest } = context
    // Access any context properties
    return tree
}
```

### Step State Access

The context object provides access to other steps' state and results:

- `context.steps` - Access to all steps by name (e.g., `context.steps.findTree.result`)
- `context.steps.step_name.result` - Access step results
- `context.steps.step_name.state` - Access step state
- `context.lastStep` - Shorthand for the immediately preceding step's result and state

**Prefer explicit `steps.name.result`** for robustness. Use `lastStep` as a shorthand for simple linear workflows where you just need "whatever came before me."

**Examples:**

```typescript
// Access specific step by name (preferred)
function processTree({ steps }) {
    const tree = steps.findTree.result
    const chopped = steps.chopTree.result
    // process both
    return processed
}

// Access step state
function analyze({ steps }) {
    const count = steps.findTree.state.count
    return { count }
}

// Shorthand: Access previous step result (use for simple linear flows)
function chopTree({ lastStep }) {
    const tree = lastStep.result
    // chop the tree
    return choppedTree
}

// Combine explicit and shorthand
function complexStep({ lastStep, steps }) {
    const previous = lastStep.result
    const specific = steps.findTree.result
    return { previous, specific }
}

// Set description for UI display
function chopTree({ steps, state }) {
    const tree = steps.findTree.result
    const pieces = 10

    // Set human-readable description
    state.description = `Chopped tree ${tree.treeId} into ${pieces} pieces`

    return { chopped: true, pieces }
}
```

**Note:** `lastStep` is position-dependent. If you reorder steps, `lastStep` will refer to a different step. For workflows where step order may change, prefer explicit `steps.name.result` references.

### Step Types

Steps support multiple creation patterns:

1. **Custom Function Steps**
   ```typescript
   function findTree({ steps, input }) {
       // Your custom logic
       return tree
   }
   ```

2. **Predefined Step Types**
   - Helper functions that return step functions
   - Import from 'rival': `import { httpStep, delayStep } from 'rival'`
   ```typescript
   import { httpStep, delayStep } from 'rival'

   // Builder API
   workflow.step(httpStep({ url: 'https://api.example.com', method: 'GET' }))
   workflow.step(delayStep({ seconds: 20 }))

   // File-based API
   export const steps = [
       validateInput,
       httpStep({ url: 'https://api.example.com/data', method: 'POST' }),
       delayStep({ seconds: 5 }),  // Wait 5 seconds
       processResponse
   ]
   ```

3. **Nested Workflows**
   - Use `workflow()` to include another workflow as a step
   - Nested workflows receive the parent workflow's context
   - The nested workflow's final result becomes the step result
   ```typescript
   import { workflow } from 'rival'

   // Reference a file-based workflow
   const paymentFlow = workflow('./payment.ts')

   // Or use a builder-created workflow directly
   const notificationFlow = createWorkflow('notify').step(sendEmail).step(sendSms)

   // Include in steps array - treated as a single step
   export const steps = [
       validateOrder,
       paymentFlow,        // Runs entire payment workflow
       notificationFlow,   // Runs entire notification workflow
       finalizeOrder
   ]
   ```

   **How nested workflows work:**
   - Nested workflow receives `{ input, steps, lastStep, log }` from parent
   - Parent's `steps` object is passed through (nested can access parent step results)
   - Nested workflow runs all its steps sequentially
   - Final step's result becomes the nested workflow's result
   - Accessible in parent via `steps.paymentFlow.result`

### Context Object Structure

The context object passed to step functions contains:

```typescript
interface StepContext {
    input: any // Workflow input (validated by Zod schema)
    state: {
        description?: string // Human-readable description of what the step did
        skipped?: boolean // Set to true to mark step as skipped
        [key: string]: any // Additional step-specific state
    }
    lastStep: {
        result: any      // undefined for first step
        state: any       // {} for first step
        stepName: string | null  // null for first step
    }
    steps: {
        [stepName: string]: {
            result: any
            state: {
                description?: string
                skipped?: boolean
                [key: string]: any
            }
            status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
        }
    }
    log: {
        debug: (msg: string) => void
        debug: (obj: object, msg?: string) => void
        info: (msg: string) => void
        info: (obj: object, msg?: string) => void
        warn: (msg: string) => void
        warn: (obj: object, msg?: string) => void
        error: (msg: string) => void
        error: (obj: object, msg?: string) => void
    }
}
```

**Notes:**
- `input`: The validated workflow input (from Zod schema). Available to all steps.
- `state`: Steps can set their own state, including `description` for UI summaries.
- `state.skipped`: Set to `true` to mark the step as skipped (status becomes `'skipped'`).
- `lastStep`: For the first step, this is an empty object: `{ result: undefined, state: {}, stepName: null }`. Safe to access properties without null checks.
- `log`: Pino-based logger with automatic context (workflow ID, step name).

## Workflow API

Rival supports **two ways** to define workflows:

1. **Builder API** - Programmatic, flexible, good for dynamic workflows
2. **File-Based API** - Simple, declarative, functions in a file = steps in order

Both approaches create the same workflow type and can be used together.

### Workflow Builder Pattern

Workflows can be created using a fluent builder API:

```typescript
import { createWorkflow } from 'rival'
import { z } from 'zod'

const workflow = createWorkflow('myWorkflow')
    .input(z.object({
        treeType: z.string(),
        location: z.string().optional()
    }))
    .step(findTree)
    .step(chopTree)
    .register()
```

### File-Based Workflow Definition

Workflows can be defined in a file using an explicit `steps` array to define execution order.

**Basic Example:**
```typescript
// workflows/tree-processing.ts
import { z } from 'zod'

// Optional: Input schema
export const input = z.object({
    treeType: z.string(),
    location: z.string().optional()
})

// Step functions
function findTree({ input }) {
    return { treeId: 'oak-123', location: input.location }
}

function chopTree({ steps, state }) {
    const tree = steps.findTree.result
    state.description = `Chopped tree ${tree.treeId}`
    return { chopped: true, pieces: 10 }
}

function processTree({ steps }) {
    return { processed: true, product: 'lumber' }
}

// Required: Steps array defines execution order
export const steps = [findTree, chopTree, processTree]
```

**With Reusable Steps:**
```typescript
// workflows/tree-processing.ts
import { z } from 'zod'
import { workflow } from 'rival'

// Import reusable steps from other files
import { findTree, chopTree } from './steps/tree-steps'
import { validateInput } from './steps/validation'

// Optional configuration
export const input = z.object({ treeType: z.string() })
export const name = 'treeProcessing'  // Override inferred name

// Define steps inline
function processTree({ steps }) {
    return { processed: true }
}

// Nested workflow (becomes a step)
const paymentWorkflow = workflow('./payment.ts')

function finalize({ steps }) {
    return { completed: true }
}

// Required: Steps array defines execution order
export const steps = [validateInput, findTree, chopTree, paymentWorkflow, processTree, finalize]
```

**With Step Configuration (Timeouts, Error Handlers):**
```typescript
// workflows/tree-processing.ts
import { z } from 'zod'

export const input = z.object({ treeType: z.string() })

function findTree({ input }) {
    return { treeId: 'oak-123' }
}

function chopTree({ steps }) {
    return { chopped: true }
}

function processTree({ steps }) {
    return { processed: true }
}

// Mix simple functions and config objects
export const steps = [
    findTree,  // Simple function
    { fn: chopTree, timeout: 60000, onTimeout: 'retry', maxAttempts: 3 },  // With timeout
    { fn: processTree, onError: notifyTeam }  // With error handler
]
```

**Exports in Workflow Files:**
- `export const steps` - **Required.** Array of step functions in execution order
- `export const input` - Optional. Zod schema for workflow input
- `export const name` - Optional. Override workflow name (default: filename)
- `export const onError` - Optional. Workflow-level error handler (fires on any step failure)

**Defaults (if not specified):**
- `name`: Inferred from filename (`tree-processing.ts` → `tree-processing`)
- `input`: None (workflow takes no input, `context.input` is `undefined`)
- `onError`: None (errors propagate, workflow fails)

**Registration:**

**Auto-Discovery:**
```typescript
// Automatically discover and register all workflow files
registerWorkflowsFromDirectory('./workflows')
```

**Explicit Registration:**
```typescript
// Register a specific workflow file
registerWorkflowFile('./workflows/tree-processing.ts')
```

**How It Works:**
1. File is analyzed for `steps` array export
2. Step functions are extracted in array order
3. Optional exports (`input`, `name`, `onError`) configure the workflow
4. Workflow is created and registered
5. Workflow name is derived from filename (or `name` export)

### Workflow Input Schema

Workflows define their input schema using **Zod**:
- Input schema is required if workflow needs input
- Frontend automatically generates forms based on Zod schema
- Input is validated before workflow execution
- Input is available to all steps via `context.input`

**Input Validation Failure:**
If input fails Zod validation, `launch()` throws a `ZodError` immediately. No workflow actor is created. The caller (frontend) should catch this error and display validation messages to the user.

```typescript
// Example with Zod schema
const workflow = createWorkflow('processOrder')
    .input(z.object({
        orderId: z.string().uuid(),
        quantity: z.number().min(1),
        priority: z.enum(['low', 'medium', 'high']).optional()
    }))
    .step(validateOrder)
    .step(processPayment)
    .register()
```

### Step Configuration Methods

The builder supports both individual step addition and batch configuration:

1. **Individual Step Addition**
   ```typescript
   workflow.step(findTree)
   workflow.step(chopTree)
   ```

2. **Batch Step Configuration with Options**
   ```typescript
   workflow.steps([
       { fn: findTree, timeout: 30000, onTimeout: 'retry', maxAttempts: 3 },
       { fn: chopTree, onError: slackError },
       { fn: processTree }
   ])
   ```

3. **Simple Array Syntax**
   ```typescript
   workflow.steps([findTree, chopTree, processTree])
   ```

### Step Descriptions

Steps can set human-readable descriptions via `state.description`:

```typescript
function chopTree({ steps, state }) {
    const tree = steps.findTree.result
    const pieces = 10

    // Set description for UI display
    state.description = `Chopped tree ${tree.treeId} into ${pieces} pieces`

    return { chopped: true, pieces }
}
```

**UI Display:**
- Descriptions appear in workflow UI as summaries
- Shown in step cards and workflow overview
- Makes it easy to understand workflow execution at a glance

### Conditional Steps (Skipping)

Steps can mark themselves as skipped by setting `state.skipped = true`:

```typescript
function sendUrgentAlert({ input, state }) {
    if (input.priority !== 'high') {
        state.skipped = true
        state.description = 'Skipped: priority is not high'
        return null
    }

    // ... send alert
    return { sent: true }
}
```

When `state.skipped = true`:
- Step status becomes `'skipped'`
- UI shows the step differently (grayed out, ⏭ icon)
- Workflow continues to the next step

**Note:** For complex branching and looping logic, handle it within your step functions. Advanced branching/looping patterns are deferred to future phases.

### Error Handling

Error handling uses the `StepError` class, which allows steps to specify how errors should be handled:

**StepError Class:**

```typescript
import { StepError } from 'rival'

function findTree({ input }) {
    try {
        // ... do something
    } catch (e) {
        if (e.code === 'TIMEOUT') {
            // Retry this error
            throw new StepError('Database timeout', {
                behavior: 'retry',
                maxAttempts: 3,
                backoff: 'exponential'
            })
        }
        // Stop workflow on this error
        throw new StepError('Invalid data', { behavior: 'stop' })
    }
}
```

**StepError Options:**

```typescript
throw new StepError(message, {
    behavior: 'stop' | 'continue' | 'retry',
    maxAttempts?: number,      // For retry behavior
    backoff?: 'linear' | 'exponential'  // For retry behavior (future: add jitter)
})
```

- `behavior: 'stop'` (default) — Stop the workflow
- `behavior: 'continue'` — Log error and continue to next step
- `behavior: 'retry'` — Retry the step with specified retry config

**Workflow-Level Error Handler:**

A workflow-level error handler fires on any step failure (useful for notifications, logging):

```typescript
// workflows/tree-processing.ts
export const onError = ({ error, failedStep, workflowState }) => {
    // error: the exception/error that occurred
    // failedStep: { result, state, stepName, status }
    // workflowState: { input, steps, status, runId, workflowName }
    sendToSlack(`Workflow ${workflowState.workflowName} failed at ${failedStep.stepName}`)
}
```

**Per-Step Error Handlers:**

Steps can have custom error handlers for step-specific logic (overrides workflow-level):

```typescript
// Error handler function
function notifyPaymentTeam({ error, failedStep, workflowState }) {
    // Step-specific notification
    sendToPaymentTeam(`Payment step failed: ${error.message}`)
}

// Attach to step via config object
workflow.step({ fn: processPayment, onError: notifyPaymentTeam })
```

**Error Handler Priority:**
1. Per-step `onError` runs first (if defined)
2. Workflow-level `onError` runs after (if defined)
3. Both receive the same error context

**Default Behavior:**

If a step throws a regular error (not `StepError`), the workflow stops (fail-fast).

### Step Timeouts

Steps can have timeouts to prevent hanging:

```typescript
export const steps = [
    { fn: findTree, timeout: 30000 },  // 30 seconds
    { fn: chopTree, timeout: 60000, onTimeout: 'retry', maxAttempts: 3, backoff: 'exponential' },
]
```

**Timeout Options:**
- `timeout: number` — Timeout in milliseconds
- `onTimeout: 'stop' | 'retry'` — What to do when timeout occurs (default: `'stop'`)
- `maxAttempts: number` — For retry on timeout
- `backoff: 'linear' | 'exponential'` — Backoff strategy for retries (default: `'linear'`)

When a step times out:
1. If `onTimeout: 'stop'` — Step fails, workflow stops
2. If `onTimeout: 'retry'` — Step retries up to `maxAttempts` times with backoff

### Complete Examples

**Builder API Example:**
```typescript
import { createWorkflow } from 'rival'
import { z } from 'zod'

const workflow = createWorkflow('treeProcessing')
    .input(z.object({
        treeType: z.string(),
        location: z.string()
    }))
    .steps([
        { fn: findTree, timeout: 30000, onTimeout: 'retry', maxAttempts: 3 },
        { fn: chopTree },
        { fn: processTree, onError: customErrorHandler }
    ])
    .register()
```

**File-Based Example:**
```typescript
// workflows/tree-processing.ts
import { z } from 'zod'
import { workflow } from 'rival'
import { findTree } from './steps/tree-steps'

// Configuration
export const input = z.object({
    treeType: z.string(),
    location: z.string()
})

function chopTree({ steps, state }) {
    state.description = `Chopped ${steps.findTree.result.treeId}`
    return { chopped: true }
}

// Nested workflow
const paymentWorkflow = workflow('./payment.ts')

function processTree({ steps }) {
    return { processed: true }
}

// Steps array defines execution order
export const steps = [findTree, chopTree, paymentWorkflow, processTree]
```

**Reusable Steps Example:**
```typescript
// steps/tree-steps.ts
export function findTree({ input }) {
    return { treeId: 'oak-123', location: input.location }
}

export function chopTree({ steps }) {
    return { chopped: true, pieces: 10 }
}

// workflows/tree-processing.ts
import { z } from 'zod'
import { findTree, chopTree } from '../steps/tree-steps'
import { validateInput } from '../steps/validation'

export const input = z.object({ treeType: z.string() })

// Add workflow-specific steps
function processTree({ steps }) {
    return { processed: true }
}

// Steps array defines execution order
export const steps = [validateInput, findTree, chopTree, processTree]
```

## Workflow Registry

### WorkflowRegistry Actor

The `WorkflowRegistry` is a Rivet actor that manages registered workflows:

```typescript
import { WorkflowRegistry } from 'rival'

const registry = new WorkflowRegistry()
registry.register(workflow) // Register a workflow
```

**Registry Methods:**

```typescript
interface WorkflowRegistry {
    // Registration
    register(workflow: Workflow): void

    // Discovery
    list(): WorkflowMetadata[]

    // Execution
    launch(workflowName: string, input: any): { runId: string }

    // Monitoring
    getWorkflow(runId: string): WorkflowActor
    getActiveRuns(workflowName?: string): RunInfo[]

    // Control
    cancel(runId: string): void
}
```

**Workflow Metadata:**
Returned by `list()`:
```typescript
interface WorkflowMetadata {
    name: string
    inputSchema: ZodSchema // For form generation
    description?: string
    stepCount: number
}
```

### Launching Workflows

**Backend:**
```typescript
// Generate unique run ID (timestamp or UUID)
const runId = `myWorkflow-run-${Date.now()}`
// Create workflow actor instance with run ID
// Execute workflow with input
```

**Frontend:**
- Calls `workflowRegistry.launch('myWorkflow', input)`
- Backend generates unique run ID
- Returns run ID for monitoring
- Frontend can connect to workflow actor to monitor progress

### Workflow Registration

**File-Based Workflows:**
- Workflows can be defined in files (`.ts` files in a workflows directory)
- Auto-discovery: `registerWorkflowsFromDirectory('./workflows')`
- Explicit: `registerWorkflowFile('./workflows/my-workflow.ts')`
- File exports are analyzed to extract steps and configuration

**Builder API Workflows:**
- Workflows created programmatically using builder API
- Registered via `.register()` method
- Can be in any file, registered at server startup

**Both approaches:**
- Create the same workflow type
- Can be mixed (file-based workflow can use builder-created nested workflows and vice versa)
- Registered in the same WorkflowRegistry

### Workflow Execution Lifecycle

1. **Registration:** Workflows registered at server startup (from files or builder API)
2. **Launch:** Frontend calls `registry.launch(name, input)`
3. **Run ID:** Backend generates unique run ID (e.g., UUID or timestamp-based)
4. **Actor Creation:** Workflow actor created with key `[workflowName, runId]`
5. **Step Actors:** Each step gets actor with key `[workflowName, runId, stepName]`
6. **Execution:** Steps execute sequentially, wrapped in step actors
7. **Persistence:** Step actors persist after completion for inspection
8. **No Reuse:** Each workflow run is a unique instance (cannot re-run same run ID)

**Note:** No hot reloading in Phase 1 - restart server to pick up workflow changes.

### Workflow Cancellation

Running workflows can be cancelled via the workflow actor:

```typescript
// From backend
const workflowActor = registry.getWorkflow(runId)
await workflowActor.cancel()

// From frontend (via registry)
await registry.cancel(runId)
```

**What happens on cancel:**
1. Workflow status set to `'cancelled'`
2. Current step actor is stopped (if running)
3. `workflow:cancelled` event is broadcast for UI updates
4. Workflow actor persists for inspection

## Observability

### Logging

Rival uses **Pino** for structured logging, integrated with Rivet's existing logger.

**Usage in Steps:**
```typescript
function findTree({ input, log }) {
    log.info({ treeType: input.treeType }, 'Searching for tree')

    const tree = findTreeInDatabase(input.treeType)

    log.debug({ treeId: tree.id }, 'Tree found')
    return tree
}
```

**Automatic Context:**
Every log entry automatically includes:
- `workflowId` — Unique workflow run ID
- `stepName` — Current step name
- `timestamp` — When the log was created

**Log Levels:**
- `log.debug()` — Verbose debugging info (hidden by default in UI)
- `log.info()` — Normal operation info
- `log.warn()` — Warning conditions
- `log.error()` — Error conditions

### Log Storage

Logs are stored in two places:

1. **Step-level logs** — Each step actor stores its own `logs: LogEntry[]`
2. **Workflow-level logs** — Workflow actor aggregates all step logs chronologically

```typescript
interface LogEntry {
    level: 'debug' | 'info' | 'warn' | 'error'
    message: string
    timestamp: number
    metadata?: Record<string, any>
    stepName?: string  // Only on workflow-level logs
}
```

**UI Views:**
- **Per-step logs** — Focused view of one step's logs
- **Workflow logs** — Full timeline across all steps, filterable by step/level

### Step Metrics

Each step actor tracks basic metrics:

```typescript
interface StepMetrics {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
    startedAt?: number
    completedAt?: number
    duration?: number      // completedAt - startedAt
    retryCount: number
    error?: {
        message: string
        stack?: string
        attemptNumber: number
        occurredAt: number
    }
}
```

**Available via:**
- Step actor state
- Workflow actor's `steps` object
- UI step cards and workflow overview

## Actor Model Architecture

Rival is built on **Rivet**, which provides stateful actors with disk persistence. This enables deployment as a single executable without external databases.

### Core Principles

1. **Everything is a Supervisor or a Step** - Workflows, branches, loops, and parallel blocks are all supervisor actors. Steps are leaf actors that execute work.
2. **Actors own their state** - Each actor manages its own state and persists it independently.
3. **Broadcasting derives from state changes** - Actors don't manually broadcast; state changes trigger notifications automatically. This maintains single responsibility.
4. **Supervisors orchestrate, steps execute** - Supervisors are "dumb" interpreters of a plan. They don't contain business logic.
5. **Actor types are code, instances are state** - Functions are embedded in actor definitions at registration. Distribution happens at the instance level.

### Actor Types vs Instances

This distinction is critical for understanding how Rival works with Rivet's distribution model:

```
ACTOR TYPES (Code)                    ACTOR INSTANCES (State)
─────────────────────                 ──────────────────────────
Defined at registration               Created at runtime
Deployed to ALL servers               Live on ONE server (Rivet routes)
Contain the step function             Contain execution state
Same code everywhere                  Unique per workflow run

findTreeStep (actor type)      →      findTreeStep["wf-123-findTree"] (instance on Server A)
                               →      findTreeStep["wf-456-findTree"] (instance on Server B)

chopTreeStep (actor type)      →      chopTreeStep["wf-123-chopTree"] (instance on Server C)
```

**Registration (all servers get this code):**
```typescript
// Actor TYPE - the blueprint with function embedded
const findTreeStep = actor({
    state: { status: 'pending', result: null },
    actions: {
        execute: (c, ctx) => findTree(ctx)  // Function baked in
    }
});

const registry = setup({
    use: { findTreeStep, chopTreeStep, workflowCoordinator }
});
```

**Runtime (instances created on-demand, Rivet routes):**
```typescript
// Coordinator doesn't know/care which server the instance lives on
const step = client.findTreeStep.getOrCreate([workflowId, 'findTree']);
await step.execute(context);  // Rivet routes to correct server
```

This is Rivet's **Coordinator/Data pattern**: coordinator creates and orchestrates data actor instances. Rivet handles the distribution transparently.

### Actor Types

| Actor Type | Responsibility |
|------------|----------------|
| `WorkflowSupervisor` | Orchestrate steps sequentially, manage sub-supervisors, handle cancellation |
| `StepActor` | Execute a function, manage own state (status, result, errors, retries, logs) |
| `BranchSupervisor` | Evaluate condition, execute one path (then or else) |
| `LoopSupervisor` | Evaluate condition, execute body repeatedly until condition is false |
| `ParallelSupervisor` | Spawn all children concurrently, await all results |

### Supervisor Hierarchy (Fractal Pattern)

Supervisors can contain other supervisors, enabling arbitrary nesting:

```
WorkflowSupervisor "order-process"
    │
    ├── StepActor "validateOrder"
    │
    ├── BranchSupervisor "checkInventory"
    │       ├── StepActor "processInStock" (then path)
    │       └── StepActor "backorderItem" (else path)
    │
    ├── ParallelSupervisor "notifications"
    │       ├── StepActor "sendEmail"
    │       ├── StepActor "sendSms"
    │       └── StepActor "updateCRM"
    │
    └── WorkflowSupervisor "shipping" (nested workflow)
            ├── StepActor "calculateRate"
            └── StepActor "createLabel"
```

### The Plan (AST)

When a workflow is registered, it generates a **plan** - an abstract syntax tree that describes the workflow structure. This plan drives both execution and UI rendering.

```typescript
type PlanNode =
    | { type: 'step', name: string, actorType: string, config?: StepConfig }
    | { type: 'branch', name: string, conditionActorType: string, then: PlanNode[], else: PlanNode[] }
    | { type: 'loop', name: string, conditionActorType: string, body: PlanNode[] }
    | { type: 'parallel', name: string, children: PlanNode[] }
    | { type: 'workflow', name: string, coordinatorActorType: string }
```

**Key insight:** The plan references **actor type names** (strings), not functions. Functions are already embedded in the actor definitions at registration time. The coordinator uses these type names to call `client[actorType].getOrCreate(...)`.

```typescript
// Plan is serializable data - no functions
const plan: PlanNode[] = [
    { type: 'step', name: 'findTree', actorType: 'findTreeStep' },
    { type: 'step', name: 'chopTree', actorType: 'chopTreeStep', config: { timeout: 60000 } },
    { type: 'step', name: 'processTree', actorType: 'processTreeStep' },
]

// Coordinator interprets the plan
for (const node of plan) {
    if (node.type === 'step') {
        // actorType tells us which actor to create
        const stepActor = client[node.actorType].getOrCreate([workflowId, node.name]);
        await stepActor.execute(context);
    }
}
```

**Phase 1:** The plan is a flat array of step nodes (sequential execution only).

**Future phases:** The plan supports nested structures for branches, loops, and parallel execution.

**UI Generation:** The same plan structure renders the workflow visualization. The UI subscribes to actors and updates node status in real-time. Since the plan is pure data (no functions), it can be serialized and sent to the frontend.

### State and Broadcasting

**Step actors own their state:**
```typescript
interface StepActorState {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
    result: any
    error: { message: string, stack?: string } | null
    attempts: number
    logs: LogEntry[]
    description: string | null
    startedAt: number | null
    completedAt: number | null
}
```

**Broadcasting is automatic:** When an actor's state changes, the system broadcasts the change. Actors don't call `broadcast()` manually - they just update state.

```typescript
// Step actor just updates state
c.state.status = 'running'  // System automatically notifies subscribers

// Not this (manual broadcasting)
c.state.status = 'running'
c.broadcast('step:started')  // Redundant - derived from state change
```

This keeps actors focused on one thing: managing their state.

### Communication Flow

```
┌─────────────────────────────────────────────────────────────┐
│                            UI                                │
│  (subscribes to workflow + step actors via Rivet)           │
└─────────────────────────────────────────────────────────────┘
        ▲                    ▲                    ▲
        │ state changes      │ state changes      │ state changes
        │                    │                    │
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Workflow      │    │  Step Actor   │    │  Step Actor   │
│ Supervisor    │    │  "findTree"   │    │  "chopTree"   │
│               │    │               │    │               │
│ - orchestrate │    │ - execute fn  │    │ - execute fn  │
│ - interpret   │◄───│ - own state   │◄───│ - own state   │
│   plan        │ret │ - retries     │ret │ - retries     │
│ - cancel      │    │ - logs        │    │ - logs        │
└───────────────┘    └───────────────┘    └───────────────┘
```

- **UI subscribes** to both workflow and step actors directly
- **Steps return results** to their supervisor (not broadcast)
- **Supervisor reacts** to step results (continue, stop on failure, etc.)
- **Each actor's state changes** trigger UI updates automatically

### Cancellation Propagation

When a workflow is cancelled:
1. Workflow supervisor sets its status to `'cancelled'`
2. Supervisor calls `cancel()` on the currently running step actor
3. If there are nested workflows, supervisor calls `cancel()` on them
4. Each actor updates its state, triggering UI updates

## Implementation Architecture

### Function-to-Actor Bridge

Rival transforms user-defined step functions into Rivet actors at **registration time**, not runtime. This aligns with Rivet's Coordinator/Data pattern and enables distribution.

**Registration Time (Build Phase):**

1. User defines steps as functions or config objects:
```typescript
export const steps = [
    findTree,
    { fn: chopTree, timeout: 60000, maxAttempts: 3 },
    processTree
]
```

2. Rival transforms each step into an **actor TYPE** with the function embedded:
```typescript
// Generated for each step - function is BAKED IN
const findTreeStep = actor({
    state: {
        status: 'pending' as StepStatus,
        result: null as unknown,
        error: null as string | null,
        attempts: 0,
        logs: [] as LogEntry[],
        startedAt: null as number | null,
        completedAt: null as number | null,
    },
    actions: {
        execute: async (c, context: StepContext) => {
            c.state.status = 'running';
            c.state.startedAt = Date.now();

            try {
                // Function is HERE - embedded at registration, not looked up
                const result = await findTree({ ...context, log: createLogger(c) });

                c.state.result = result;
                c.state.status = 'completed';
                c.state.completedAt = Date.now();
                return result;
            } catch (error) {
                c.state.status = 'failed';
                c.state.error = error.message;
                c.state.completedAt = Date.now();
                throw error;
            }
        },
        getState: (c) => ({ ...c.state }),
    }
});
```

3. All step actors + coordinator are registered in Rivet's registry:
```typescript
// All actors registered together - this is deployed to ALL servers
const registry = setup({
    use: {
        findTreeStep,      // Step actor type
        chopTreeStep,      // Step actor type
        processTreeStep,   // Step actor type
        workflowCoordinator,
    }
});
```

**Runtime (Execution Phase):**

4. Coordinator creates **INSTANCES** of step actor types:
```typescript
const workflowCoordinator = actor({
    state: { /* workflow state */ },
    actions: {
        run: async (c, workflowId: string, input: unknown) => {
            const client = c.client();

            // Create step instance - Rivet routes to correct server
            const step1 = client.findTreeStep.getOrCreate([workflowId, 'findTree']);
            const result1 = await step1.execute({ input, steps: {}, lastStep: {} });

            // Create next step instance
            const step2 = client.chopTreeStep.getOrCreate([workflowId, 'chopTree']);
            const result2 = await step2.execute({
                input,
                steps: { findTree: { result: result1, status: 'completed' } },
                lastStep: { result: result1, stepName: 'findTree' }
            });

            // Continue for remaining steps...
        }
    }
});
```

**Why This Design:**

- **No runtime function registry** - Functions are embedded in actor definitions at registration
- **Works with Rivet distribution** - Actor types are code (deployed everywhere), instances are state (routed by Rivet)
- **Follows Coordinator/Data pattern** - Coordinator orchestrates, step actors execute
- **Type-safe** - Each step actor type has its function baked in with proper typing

### Frontend Behavior (Phase 1)

**Phase 1 Frontend is minimal:**
- Lists all registered workflows (from WorkflowRegistry)
- Dynamically generates forms from Zod input schemas
- Launches workflows via `registry.launch(name, input)`
- Monitors workflow execution via Rivet's `useActor` hook
- **No dynamic workflow creation** - developers define workflows in code

### Type Safety

**Default Behavior:**
- Context object is typed
- Step results are `any` type by default (file-based workflows)
- Builder API can support stronger type inference

**Optional Type Safety with Results Helper:**

For developers who want full type safety, Rival provides an optional `Results` helper:

**With Zod (recommended):**
```typescript
// workflows/tree-processing.ts
import { z } from 'zod'
import { Results } from 'rival'

// Define result schemas with Zod
export const results = Results({
    findTree: z.object({ treeId: z.string(), species: z.string() }),
    chopTree: z.object({ pieces: z.number() })
})

function findTree({ input }): z.infer<typeof results.schemas.findTree> {
    return { treeId: 'oak-123', species: 'oak' }
}

function chopTree({ steps }: { steps: typeof results.Steps }) {
    steps.findTree.result.treeId   // ✓ fully typed, autocomplete works
    return { pieces: 10 }
}

export const steps = [findTree, chopTree]
```

**Without Zod (plain types):**
```typescript
import { Results } from 'rival'

export const results = Results<{
    findTree: { treeId: string; species: string }
    chopTree: { pieces: number }
}>()

function chopTree({ steps }: { steps: typeof results.Steps }) {
    steps.findTree.result.treeId   // ✓ fully typed
    return { pieces: 10 }
}
```

**What Results provides:**
- `results.Steps` — Typed `steps` object for function signatures
- `results.schemas` — Zod schemas (if using Zod) for optional runtime validation

**Tradeoffs:**

| Approach | Boilerplate | Autocomplete | Runtime Validation |
|----------|-------------|--------------|-------------------|
| No types | None | No | No |
| Plain types | ~3 lines | Yes | No |
| Zod types | ~3 lines | Yes | Yes (optional) |

**Note:** Types are compile-time only. For runtime validation of step outputs, use Zod schemas.

### Parallel Execution

**Rivet Support:**
- Rivet supports parallel execution via `Promise.all()`
- Multiple actors can run concurrently
- Fan-out pattern: one actor spawns work across multiple actors

**Phase 1:**
- Sequential execution only
- Architecture designed to support parallel execution in future phases
- Context structure allows for `previousSteps: StepResult[]` in parallel mode

## Phase 1 Scope

### Included
- ✅ Function-based step definitions with context injection
- ✅ **Two workflow definition methods:** Builder API and File-Based API
- ✅ Workflow builder API with fluent interface
- ✅ File-based workflows with explicit `steps` array for ordering
- ✅ Auto-discovery and explicit registration of workflow files
- ✅ Reusable steps (import from other files)
- ✅ Nested workflows in file-based definitions
- ✅ Zod input schema definition (`export const input`)
- ✅ Optional type safety with `Results` helper (Zod or plain types)
- ✅ WorkflowRegistry actor for listing/launching
- ✅ Error handling with `StepError` class (includes retry config)
- ✅ Per-step error handlers (`onError`)
- ✅ Step timeouts with `onTimeout: 'stop' | 'retry'`
- ✅ Workflow cancellation
- ✅ Conditional steps (`state.skipped = true`)
- ✅ Predefined step types (httpStep, delayStep, etc.)
- ✅ Step descriptions (`state.description`)
- ✅ Pino-based structured logging (`context.log`)
- ✅ Step metrics (duration, retryCount, status)
- ✅ Step-level and workflow-level log storage
- ✅ Sequential step execution
- ✅ Frontend: list, launch, cancel, and monitor workflows

### Deferred to Later Phases
- ❌ `BranchSupervisor` - Conditional execution paths
- ❌ `LoopSupervisor` - Repeated execution until condition met
- ❌ `ParallelSupervisor` - Concurrent step execution
- ❌ Global error handlers (workflow-level onError)
- ❌ Retry jitter and exponential backoff
- ❌ Raw step actors (advanced customization)
- ❌ Hot reloading of workflows
- ❌ Step dependency validation at registration
- ❌ Library/embedded mode (Phase 2)
- ❌ Advanced metrics (histograms, aggregations)
- ❌ Testing utilities (mock helpers)
- ❌ SQLite index for workflow run queries (filter by input, date, status)

### Future: Branching, Looping, and Parallel Execution

Complex control flow patterns are deferred to future phases. When implemented, each pattern becomes a **supervisor actor** following the same fractal pattern as workflows.

#### Branching (BranchSupervisor)

Execute different steps based on conditions:

```typescript
// Conceptual - not Phase 1
workflow
    .step(validateOrder)
    .branch({
        name: 'checkValid',
        if: ({ steps }) => steps.validateOrder.result.isValid,
        then: [processPayment, shipOrder],
        else: [notifyCustomer, cancelOrder]
    })
```

**How it works:**
- Creates a `BranchSupervisor` actor
- Supervisor evaluates the condition
- Executes the `then` or `else` path (which may contain steps or other supervisors)
- Reports result back to parent workflow

#### Looping (LoopSupervisor)

Repeat steps until a condition is met:

```typescript
// Conceptual - not Phase 1
workflow
    .step(fetchBatch)
    .loop({
        name: 'processBatches',
        body: [processBatch, fetchNextBatch],
        until: ({ steps }) => steps.fetchNextBatch.result.done
    })
```

**How it works:**
- Creates a `LoopSupervisor` actor
- Supervisor evaluates the condition before each iteration
- Executes body steps, creating new step actors per iteration (keyed by iteration number)
- Reports final result back to parent workflow

#### Parallel Execution (ParallelSupervisor)

Execute multiple steps concurrently:

```typescript
// Conceptual - not Phase 1
workflow
    .step(validateOrder)
    .parallel({
        name: 'notifications',
        steps: [sendEmail, sendSms, updateCRM]
    })
    .step(finalize)
```

**How it works:**
- Creates a `ParallelSupervisor` actor
- Spawns all child step actors concurrently
- Awaits all results (`Promise.all`)
- Reports aggregated result back to parent workflow

#### Why Supervisors?

Using supervisor actors for control flow:
- **Consistent model** - Everything is either a supervisor or a step
- **State isolation** - Each branch/loop/parallel block owns its state
- **UI visibility** - UI can show branch decisions, loop iterations, parallel progress
- **Cancellation** - Parent cancels supervisor, supervisor cancels its children
- **Composable** - Supervisors can contain other supervisors (branch inside loop inside parallel)

#### For Phase 1

Handle branching and looping logic inside your step functions:

```typescript
function processAllBatches({ input }) {
    let done = false
    while (!done) {
        const batch = fetchBatch()
        processBatch(batch)
        done = batch.isLast
    }
    return { processed: true }
}
```

This keeps Phase 1 simple. The architecture supports control flow supervisors without redesign.

## Summary

The redesigned system enables developers to:

**Workflow Definition:**
- **Choose workflow definition style:** Builder API for programmatic workflows, or File-Based API for simple declarative workflows
- Create workflows and steps entirely in TypeScript on the backend
- **Define workflows as files:** Export a `steps` array defining execution order
- **Reuse steps:** Import step functions from other files
- Use simple function-based step definitions with context injection
- Access step state and results through `steps.stepName.result` (prefer) or `lastStep` (shorthand)
- Define workflow input with Zod schemas (auto-generates frontend forms)
- Optionally add full type safety with the `Results` helper

**Execution & Control:**
- Set step descriptions via `state.description`
- Skip steps conditionally via `state.skipped = true`
- Leverage predefined step types (httpStep, delayStep)
- Handle errors with `StepError` class including retry configuration
- Set step timeouts with configurable retry-on-timeout behavior
- Cancel running workflows from UI or programmatically

**Observability:**
- Use structured logging with Pino (`context.log`)
- Monitor step metrics (duration, retry count, status)
- View step-level and workflow-level logs in UI

**Deployment:**
- Register workflows via auto-discovery or explicit registration
- Launch workflows from a simple frontend UI
- **Single executable deployment** - no external database required (Rivet persistence)
- Developer-first approach: workflows are code, not UI-created

**Architecture:**
- **Actor model foundation** - Built on Rivet for stateful, persistent actors
- **Supervisor pattern** - Workflows are supervisors, steps are autonomous actors
- **Fractal design** - Control flow (branches, loops, parallel) also uses supervisors
- **Plan-driven execution** - Workflow generates a plan (AST) that drives both execution and UI
- **State-derived events** - Actor state changes automatically notify subscribers (single responsibility)
