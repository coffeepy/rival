# Rival Runtime: Current State (Developer Guide)

This doc is a practical snapshot of how Rival executes workflows today.
Use it to quickly get back into context while coding.

## 1) Mental Model

Rival runs a workflow with two actor layers:

1. **Coordinator actor** (`workflow-coordinator.ts`)
- Orchestrates the workflow plan.
- Starts step actors.
- Tracks workflow state/results.
- Handles callbacks from step actors.

2. **Step actors** (`step-actor.ts`)
- Execute user step functions.
- Own retry/timeout scheduling.
- Persist step-local state.
- Notify coordinator when terminal.

Core rule: coordinator should prefer **message/callback progression** over blocking poll loops.

## 2) API Surface (Current)

From `engine.ts`:

1. `engine.run(workflowName, input?, runId?)`
- Starts execution.
- Returns `{ runId, status: "running" }`.

2. `engine.wait(workflowName, runId, options?)`
- Returns terminal workflow result.
- Uses event-first strategy with polling fallback.

3. `engine.get(workflowName).getOrCreate(runId)`
- Gives instance with:
  - `run(runId, input)`
  - `wait(options?)`
  - `cancel()`
  - `getState()`

## 3) Wait Behavior

`wait()` strategy:

1. Check state immediately via `getState()`.
2. Try event subscription path first.
3. If event path is unavailable/times out/errors, fallback to polling.

Relevant options:

1. `timeoutMs` (default `300000`)
2. `pollIntervalMs` (default `250`)
3. `preferEvents` (default `true`)
4. `eventWaitTimeoutMs` (default `3000`)

## 4) What Is Callback-Driven vs Blocking

### Callback-driven now

1. Top-level step progression.
2. Top-level loop iterator progression.
3. Top-level loop body step progression.

### Still blocking by design

1. **Nested loop internals** (loop inside loop) currently use the synchronous helper path.

Implication:
- `cancel()` can be deferred while a nested loop block is running in the coordinator action.
- This is a known tradeoff, not data corruption.

## 5) “Nested Loop Blocking” Clarified

This refers to Rival `forEach` plan nodes nested inside other Rival `forEach` nodes.
It does **not** refer to ordinary JavaScript `for` loops in your step code.

## 6) Step Retry/Timeout Model

Step actors are async-scheduled:

1. `execute(...)` kickoffs only.
2. `_attempt(token)` handles attempts.
3. `_onTimeout(token)` handles timeout policy.
4. Token guards prevent stale scheduled actions from mutating active runs.

Coordinator callbacks are addressed using persisted `coordinatorRef` + `coordinatorKey`.

## 7) Cancellation Semantics

1. `cancel()` marks workflow cancelled and bumps execution token.
2. Pending stale callbacks/schedules no-op by token/key guards.
3. Active step cancel is best-effort.
4. If currently in nested-loop blocking section, cancel is processed after that section returns.

## 8) Logging/Names You’ll See

Loop body callback step names are encoded like:

`<loopName>:iter<idx>:node<nodeIdx>:<stepName>`

This is intentional for callback correlation and debugging.

## 9) Where To Read Code First

1. `src/rival/engine.ts`
- Public API and `wait()` strategy.

2. `src/rival/core/workflow-coordinator.ts`
- Orchestration state machine, callbacks, loop handling.

3. `src/rival/core/step-actor.ts`
- Retry/timeout mechanics and coordinator notification.

4. `test/foreach-loop.test.ts`
- Most complete behavior coverage for loop semantics.

5. `test/engine.test.ts`
- API-level behavior including wait options.

## 10) Current Known Sharp Edge

Event wait can log subscription-related warnings in some local test/runtime paths while still functioning via fallback.
Behavior is correct; cleanup of warning/noise is a polish task.

