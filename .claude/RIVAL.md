# Rival - Workflow Engine

## What is Rival?

Rival is a **workflow engine library** built on top of [Rivet](https://rivet.gg) (actor framework).

**Core principles:**
- **Developer-first:** Workflows defined in TypeScript code, not UI
- **Single executable:** No external database required (Rivet handles persistence)
- **Distribution-ready:** Works with Rivet's native clustering/routing

## Two-Tier Vision

1. **Rival Library** - A library on top of Rivet that provides workflow primitives
2. **Rival Engine** - A standalone executable with UI that uses the Rival library

## Architecture

### Built on Rivet's Actor Model

Rival uses Rivet's stateful actors with disk persistence. This enables deployment as a single executable without external databases.

### Coordinator/Data Pattern

Rival follows Rivet's native **Coordinator/Data pattern**:

```
ACTOR TYPES (Code)                    ACTOR INSTANCES (State)
─────────────────────                 ──────────────────────────
Defined at registration               Created at runtime
Deployed to ALL servers               Live on ONE server (Rivet routes)
Contain the step function             Contain execution state
Same code everywhere                  Unique per workflow run
```

### Function-to-Actor Bridge

**Key insight:** Step functions are embedded in actor definitions at **registration time**, not looked up at runtime.

```typescript
// User writes:
export const steps = [findTree, chopTree, processTree]

// Rival transforms each into an actor TYPE:
const findTreeStep = actor({
    state: { status: 'pending', result: null },
    actions: {
        execute: (c, ctx) => findTree(ctx)  // Function baked in
    }
});

// All actors registered together (deployed to all servers):
const registry = setup({
    use: { findTreeStep, chopTreeStep, workflowCoordinator }
});
```

### Plan (AST)

Workflows generate a **plan** - an abstract syntax tree that references actor type names (strings), not functions:

```typescript
type PlanNode =
    | { type: 'step', name: string, actorType: string, config?: StepConfig }
    | { type: 'branch', name: string, conditionActorType: string, then: PlanNode[], else: PlanNode[] }
    | { type: 'loop', name: string, conditionActorType: string, body: PlanNode[] }
    | { type: 'parallel', name: string, children: PlanNode[] }
```

The plan is serializable (no functions) so it can be sent to the UI.

## Workflow Structure

**Everything is a Supervisor or a Step** (fractal pattern):

| Actor Type | Responsibility |
|------------|----------------|
| `WorkflowSupervisor` | Orchestrate steps sequentially, manage sub-supervisors |
| `StepActor` | Execute a function, manage own state (status, result, retries, logs) |
| `BranchSupervisor` | Evaluate condition, execute then/else path |
| `LoopSupervisor` | Execute body repeatedly until condition is false |
| `ParallelSupervisor` | Spawn all children concurrently, await all results |

Supervisors can contain other supervisors (arbitrary nesting).

## User-Facing API (Planned)

```typescript
// File-based workflow
export const steps = [
    findTree,
    { fn: chopTree, timeout: 60000, maxAttempts: 3 },
    processTree
]

// Or builder API
const workflow = createWorkflow('treeProcessing')
    .input(z.object({ treeType: z.string() }))
    .step(findTree)
    .step(chopTree)
    .register()
```

## Key Files

| File | Description |
|------|-------------|
| `redesign.md` | Full design specification |
| `poc/workflow-poc-v2.ts` | Working POC using Coordinator/Data pattern |
| `poc/multi-actor-demo.ts` | Demo showing Rivet actor distribution |
| `rivet.txt` | Rivet documentation reference |

## Current Status

**Done:**
- Design specification (redesign.md)
- POC v2 proving Coordinator/Data pattern works
- Actor types vs instances model validated

**Phase 1 (Next):**
- Build Rival library with developer-friendly API
- Registration/transformation layer (user functions → actor types)
- Basic UI for monitoring workflows
- Sequential execution only (no branch/loop/parallel yet)

**Future Phases:**
- BranchSupervisor, LoopSupervisor, ParallelSupervisor
- Advanced error handling
- Hot reloading
