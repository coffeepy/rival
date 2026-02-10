# Rival - Internal Architecture Guide

## What is Rival?

Rival is a **workflow engine library** built on [RivetKit](https://rivet.gg). It transforms TypeScript step functions into stateful RivetKit actors with automatic persistence, retry logic, and structured logging.

**Core principles:**
- **Developer-first:** Workflows defined in TypeScript code, not UI
- **Single executable:** No external database required (RivetKit handles persistence)
- **Distribution-ready:** Works with RivetKit's native clustering/routing

## Architecture

### Function-to-Actor Bridge

Step functions are embedded in actor definitions at **compile time**, not looked up at runtime. `compileWorkflow()` transforms each step function into a RivetKit actor definition with its own state management.

```
createWorkflow("name")     compileWorkflow()         rival()
  .step(fn1)          -->   { actors, plan,     -->   setup() + start()
  .step(fn2)                  coordinator }           --> RivalEngine
  .build()
```

### Actor Types

| Actor | Responsibility |
|-------|----------------|
| **StepActor** | Execute a step function, manage retries, track state/result/logs |
| **WorkflowCoordinator** | Orchestrate steps sequentially per the plan, handle errors |

Each workflow produces N step actors + 1 coordinator. Actor names are namespaced: `{workflowName}_{stepName}`.

### Plan (AST)

Workflows generate a **plan** - a serializable array of `PlanNode` objects referencing actor names (strings), not functions:

```typescript
type PlanNode =
  | StepPlanNode      // { type: 'step', name, actorRef, config? }
  | BranchPlanNode    // { type: 'branch', ... } (future)
  | LoopPlanNode      // { type: 'loop', ... } (future)
  | ParallelPlanNode  // { type: 'parallel', ... } (future)
```

Currently only `StepPlanNode` (sequential execution) is implemented.

### StepContext

Every step function receives a `StepContext` with:
- `input` - The workflow input data
- `state` - Mutable per-step state (persisted)
- `steps` - Results from all previously executed steps
- `lastStep` - Shorthand for the immediately preceding step
- `log` - Structured logger (debug/info/warn/error)

### Error Handling

- **StepError** with `behavior: "continue"` lets the workflow proceed past failures
- **StepError** with `behavior: "stop"` (default) halts the workflow
- **Retry**: Steps can be configured with `maxAttempts`, `backoff` (linear/exponential), `timeout`

## Source Layout

```
src/rival/
  index.ts                    # Public API exports
  engine.ts                   # rival() function, RivalEngine, ActorRegistry
  builder/
    workflow-builder.ts       # createWorkflow() fluent builder
    compiler.ts               # compileWorkflow(), defineWorkflow()
  core/
    step-actor.ts             # createStepActor() factory
    workflow-coordinator.ts   # createWorkflowCoordinator() factory
    context-builder.ts        # buildStepContext(), createEmptyStepState()
  logging/
    logger.ts                 # createStepLogger()
  steps/
    http-step.ts              # httpStep() factory
    delay-step.ts             # delayStep() factory
  types/
    context.ts                # StepContext, StepLogger, LogEntry
    step.ts                   # StepFunction, StepConfig, StepDefinition
    plan.ts                   # PlanNode types + Zod schemas
    workflow.ts               # WorkflowDefinition, CompiledWorkflow
    errors.ts                 # StepError class
```

## Key Files

| File | Description |
|------|-------------|
| `rivet.txt` | RivetKit documentation reference |

## Public API Surface

```
Functions:  rival, createWorkflow, compileWorkflow, defineWorkflow,
            createStepActor, createWorkflowCoordinator,
            buildStepContext, createEmptyStepState, createStepLogger,
            httpStep, delayStep

Classes:    RivalEngine, WorkflowBuilder, StepError

Schemas:    planSchema, stepPlanNodeSchema
```

## Future Work

- Branch/loop/parallel plan nodes (supervisor actors)
- Hot reloading of workflow definitions
- Workflow versioning
