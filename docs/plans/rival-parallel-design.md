# Rival Parallel Design (Fluent API)

## Goal
Add first-class parallel branch orchestration with strict Rivet actor-model compliance.

Phase 1 target: `join = "all"` (wait for all branches).

## Fluent DSL (Canonical)

```ts
const wf = createWorkflow("userSetup")
  .parallel("setup")
    .branch("db", (b) => b.step(createDatabaseUser))
    .branch("crm", (b) => b.workflow(createCRMProfileWorkflow))
    .branch("email", (b) => b.step(sendWelcomeEmail))
    .join("all")
    .finally((ctx) => ({ branchCount: 3 }))
  .step(postSetup)
  .build();
```

Notes:
- `parallel(name?)` opens a block builder.
- `branch(name, fn)` defines one branch pipeline.
- `join("all")` is required in phase 1 (default can be `all` if omitted).
- `finally(fn)` runs after join to map/normalize block result.

## Execution Contract
- Parallel block writes one entry to `stepResults` under block name.
- Branch outputs are deterministic and keyed by branch name in definition order.
- Branch hard failure fails block unless `continueOnError` semantics are configured.
- Cancellation is best-effort fan-out to active branch coordinators/step actors.

## Plan Model (Compiler)
Add `ParallelPlanNode`:
- `type: "parallel"`
- `name: string`
- `branches: Array<{ name: string; plan: PlanNode[] }>`
- `join: "all"` (phase 1)
- `parallelCoordinatorActorRef: string`
- `finallyStep?: StepPlanNode` (compiler-lowered function node)

Actor refs should use deterministic names (same encoding strategy as loop coordinators).

## Runtime Model

### New actor: `parallel-coordinator`
Responsibilities:
- start each branch execution (callback-driven)
- track in-flight/completed/failed branch states
- decide terminal result under join policy
- notify parent coordinator via callback action

### Parent coordinator interaction
- Parent starts parallel node by calling child coordinator `run(...)` and returns.
- Child notifies parent via `onParallelFinished(...)` callback.
- Parent resumes `_continue` after callback.

No polling loop in actor actions.

## Callback Protocol
Use explicit callback action for parallel completion:

`onParallelFinished(blockName, status, result, error, callbackName, parentToken)`

Guards:
- parent `status === running`
- `callbackName` matches active pending parallel callback
- `executionToken === parentToken`

## Coordinator State (Parent)
Add:
- `activeParallelName: string | null`
- `activeParallelRef: string | null`
- `activeParallelKey: string | null`
- `pendingParallelCallbackName: string | null`

Reuse existing `executionToken` for stale callback rejection.

## Coordinator State (Parallel)
- `status: pending | running | completed | failed | cancelled`
- `executionToken: number`
- `workflowId`, `runId`, `blockName`
- `branchOrder: string[]`
- `branchStates: Record<branchName, { status, result?, error?, childRef?, childKey? }>`
- `pendingCount`, `completedCount`
- `hardFailure: string | null`
- `parentRef`, `parentKey`, `parentToken`, `callbackName`

## Failure and Cancel Semantics
- Phase 1 join policy: `all`.
- If a branch hard-fails and policy requires fail-fast, stop launching new branch work and mark block failed when safe.
- Cancel on parent should propagate to all active branch children.
- Cancel callbacks and stale completions are ignored via token/callback guards.

## Phasing
1. Phase 1
- Fluent API surface
- Compiler support
- Parallel coordinator actor
- `join = all`
- tests for success/fail/cancel/nesting

2. Phase 2
- `join = first`
- `join = n`
- richer partial-result semantics

## Test Matrix (Phase 1)
- all branches succeed
- one branch fails hard
- branch `continueOnError` handling
- cancel during active fan-out
- nested usage: parallel inside loop, loop inside parallel, parallel inside branch
- deterministic output ordering
