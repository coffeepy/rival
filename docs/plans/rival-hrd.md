# Refactor `rival-hrd`: Actor-Native Retry/Timeout with `run` + `wait` API

## Summary
Refactor retry/timeout execution to actor-native scheduling (`c.schedule.after`) and decouple coordinator progression from long blocking awaits.

Adopt greenfield API semantics:
- `run(...)` starts workflow and returns immediately
- `wait(...)` returns final result
- `wait()` available on both `engine` and `instance` surfaces

## Public API Changes

### Engine API (`src/rival/engine.ts`)
1. `run(workflowName, input?, runId?)` becomes non-blocking start.
2. Return type: `{ runId: string; status: "started" | "running" }`
3. Add `wait(workflowName, runId, options?)`.
4. `wait` options:
   - `timeoutMs?: number` (default `300_000`)
   - `pollIntervalMs?: number` (default `250`)

### Instance API (`CoordinatorInstance` in `src/rival/engine.ts`)
1. Keep `run(runId, input)` as start-only when called via instance.
2. Add `wait(options?)` on instance (runId inferred from instance key).
3. Keep `getState()` and `cancel()`.

### Coordinator Actor API (`src/rival/core/workflow-coordinator.ts`)
1. `run(...)` becomes kickoff action, not full blocking executor.
2. Add continuation/callback actions to advance execution asynchronously.
3. Preserve terminal result structure (`completed/failed/cancelled` + results/error/failedStep).

## Core Refactor Design

### 1) Step Actor: Scheduled Retry/Timeout State Machine (`src/rival/core/step-actor.ts`)

#### State updates
1. Add `status: ... | "waiting_retry"`.
2. Persist execution inputs for continuation:
   - `pendingContext`
   - `pendingConfig`
   - `pendingWorkflowId`
   - `pendingStepName`
   - `coordinatorRef`
   - `coordinatorKey`
3. Add guard tokens:
   - `executionToken` for stale retry actions
   - `timeoutToken` for stale timeout actions
4. Keep `attempts` as source of truth.

#### Action model
1. `execute(...)` (kickoff only):
   - initialize/reset run state
   - persist context/config/meta
   - persist callback address (`coordinatorRef`, `coordinatorKey`) for delayed attempts
   - set running state/start time
   - schedule immediate `attempt(executionToken)`
   - schedule `onTimeout(timeoutToken)` if `config.timeout` is set
   - return immediate started/running payload

2. `attempt(token)`:
   - ignore if token stale or terminal/cancelled
   - increment persisted attempts
   - run step once
   - on success/skipped: finalize terminal + callback coordinator
   - on failure:
     - evaluate retry eligibility
     - cap retry override:
       `effectiveMax = min(err.maxAttempts ?? config.maxAttempts ?? 1, config.maxAttempts ?? Infinity)`
     - if retry allowed:
       - set `status="waiting_retry"`
       - call `await c.saveState(...)` before scheduling retry as a belt-and-suspenders durability step
       - schedule next `attempt(token)` with backoff
     - else finalize failed + callback coordinator
     - invoke step-level `onError` on terminal failure

3. `onTimeout(token)`:
   - ignore if stale token or terminal
   - apply `onTimeout` policy:
     - `stop` => fail terminal + callback
     - `retry` => call `await c.saveState(...)` then schedule retry if attempts remain, else fail terminal
   - invoke step-level `onError` on terminal timeout failure
   - never block

4. `cancel()`:
   - mark cancelled terminal
   - invalidate tokens to make pending scheduled actions no-op

#### Behavioral guarantees
1. No `sleep()` loops.
2. Actor remains responsive between attempts.
3. Retry progression survives crashes due to persisted schedule + state.
4. No `c.schedule.cancel()` support is assumed; stale scheduled wakeups are expected and safely ignored via token guards.
5. Internal continuation actions should use an internal naming convention (e.g. `_attempt`, `_onTimeout`) to signal non-public usage.

### 2) Coordinator: Non-Blocking Progression (`src/rival/core/workflow-coordinator.ts`)

#### State updates
1. Track active node execution:
   - `currentNodeIndex`
   - `activeStep?: { nodeName, actorRef, actorKey }`
2. Add continuation guard(s) for duplicate callbacks.

#### Action model
1. `run(workflowId, rawInput)`:
   - validate/init state
   - set running
   - schedule `executeNext()`
   - return immediate running metadata

2. `executeNext()`:
   - no-op if terminal/cancelled
   - dispatch current node:
     - step node: start step actor `execute(...)` kickoff, set `activeStep`, return
     - loop node: execute loop body synchronously in this phase (Option C scope lock), while individual loop step retries still use scheduled step-actor retries
     - unsupported node: mark failed terminal

3. `onStepFinished(payload)`:
   - validate payload matches active step
   - write step result
   - if hard-failed: mark workflow failed terminal
   - else increment index and schedule `executeNext()`

4. `cancel()`:
   - mark cancelled terminal
   - propagate cancel to active step when present

5. Workflow-level `onError`:
   - invoke workflow-level error handler on terminal workflow failure paths (hard step failure, loop hard failure, validation failure).

### 3) Engine/Instance `wait()` Helpers

#### `engine.wait(workflowName, runId, options?)`
1. Resolve workflow coordinator instance via `engine.get(workflowName).getOrCreate(runId)`.
2. Poll `getState()` every `pollIntervalMs`.
3. Stop on terminal state:
   - map to `WorkflowExecutionResult`.
4. Enforce timeout:
   - default `300_000ms`
   - override allowed via options
   - throw timeout error with workflowName/runId context.

#### `instance.wait(options?)`
1. Same polling logic against this instance.
2. Uses bound runId from instance key.
3. Same defaults and error semantics.

#### Future TODO: Event-driven wait
1. Add event-based waiting using actor broadcasts (`c.broadcast(...)`) to reduce polling overhead.
2. Keep polling `wait()` as baseline fallback for drivers/environments where subscriptions are unavailable.

## File-by-File Change List
1. `src/rival/core/step-actor.ts`
   - remove procedural retry loop + `sleep()`
   - add scheduled attempt/timeout/callback actions
   - add `waiting_retry` status
   - enforce capped retry override

2. `src/rival/core/workflow-coordinator.ts`
   - replace blocking `run()` workflow executor with kickoff + continuation actions
   - add step completion callback handling
   - keep loop orchestration synchronous in this phase (Option C), no full loop continuation state machine
   - preserve result recording and terminal state shape

3. `src/rival/engine.ts`
   - update `run` return contract
   - add `engine.wait`
   - add `instance.wait`
   - update exported interfaces/types

4. `src/rival/index.ts`
   - export updated types/signatures as needed

5. `README.md`
   - update examples to `run` then `wait`
   - include note that `wait()` is currently polling-based with a future event-based roadmap

6. Tests:
   - `test/engine.test.ts`
   - `test/step-actors.test.ts`
   - impacted loop/coordinator tests (`test/foreach-loop.test.ts` if needed)
   - add Vitest schedule-focused tests with fake timers (`vi.useFakeTimers()`, `vi.advanceTimersByTimeAsync()`) for retry backoff and timeout scheduling behavior

## Test Plan

### Step actor tests
1. Retries transition through `waiting_retry`.
2. Retry attempts persist across scheduled invocations.
3. `StepError.maxAttempts` cannot exceed config max.
4. Timeout stop policy fails terminal.
5. Timeout retry policy schedules retry then succeeds/fails per max attempts.
6. Cancel during waiting retry prevents further attempts.
7. Delayed retries/timeouts still callback successfully using persisted `coordinatorRef`/`coordinatorKey`.
8. Step-level `onError` is invoked exactly once on terminal step failure.

### Coordinator tests
1. `run()` returns quickly and leaves state running.
2. Progress continues via callbacks to terminal completion.
3. Hard failure sets `failedStep` correctly.
4. Continue-on-error still advances plan.
5. Cancel mid-run yields cancelled terminal state.
6. Loop behavior remains synchronous in this phase and nested loops are unchanged functionally.
7. Workflow-level `onError` fires on terminal workflow failure.

### Engine/instance API tests
1. `engine.run()` returns `{ runId, status }`.
2. `engine.wait()` returns terminal `WorkflowExecutionResult`.
3. `instance.wait()` returns terminal `WorkflowExecutionResult`.
4. Timeout path triggers with clear error.
5. Custom `pollIntervalMs` and `timeoutMs` respected.
6. Internal action names are not documented as user-facing API and are treated as implementation details.

### Regression tests
1. Sequential happy path unchanged at terminal output.
2. Existing result/state shape preserved at completion.
3. forEach (seq/par) still deterministic and correct.

## Assumptions and Defaults
1. Greenfield project; breaking API changes accepted.
2. Scope includes both retry and timeout scheduling.
3. `run` is start-only, non-blocking.
4. Both wait surfaces are provided:
   - `engine.wait(...)`
   - `instance.wait(...)`
5. `wait` defaults:
   - `timeoutMs = 300_000`
   - `pollIntervalMs = 250`
6. Timeout enforcement is orchestration-level (non-cooperative step code cannot be forcibly interrupted mid-execution).
7. Scope lock: full async loop continuation state machine is deferred; this issue implements async top-level step orchestration with synchronous loop orchestration.
