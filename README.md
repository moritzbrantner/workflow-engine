# workflow-engine

Workflow orchestration service for versioned definitions, triggers, runs, scheduling, and runner dispatch.

## MVP

The engine stores immutable compiled workflow versions and run history behind a `WorkflowEngineStore`, supports manual, webhook, and five-field UTC cron triggers, and dispatches runs through a small structural `WorkflowRunDispatcher` interface. It ships both an in-memory store and an atomic local JSON store for restart-safe single-process use.

`workflow-runner` satisfies that dispatcher interface directly, but this repository intentionally does not depend on it. The composition root can install/import both and wire them together:

```ts
import { createWorkflowEngine } from "@moritzbrantner/workflow-engine";
import { createWorkflowRunner } from "@moritzbrantner/workflow-runner";

const runner = createWorkflowRunner();
const engine = createWorkflowEngine({ dispatcher: runner });

const definition = engine.registerWorkflow({
  workflowId: "daily-report",
  workflow: compiledWorkflow,
});

engine.registerTrigger({
  type: "cron",
  workflowId: definition.workflowId,
  workflowVersion: definition.version,
  cron: "0 8 * * *",
});
```

The engine remains deliberately single-process by default. The store and dispatcher are explicit boundaries so queue-backed dispatch or another durable store can be added without changing workflow documents.

## Durable local store

```ts
import {
  createFileWorkflowEngineStore,
  createWorkflowEngine,
} from "@moritzbrantner/workflow-engine";

const store = createFileWorkflowEngineStore(".local/workflow-engine/state.json");
const engine = createWorkflowEngine({ dispatcher, store });
```

The file store atomically replaces a canonical JSON state file and serializes mutations through a lock file. Workflow-version reservation is conflict-aware, schedule claims survive restart, run identity is immutable, and terminal run states cannot regress. Lock ownership (the holder's pid, its Linux process start time, and a unique token) is published atomically. A lock whose holder process is gone, or whose pid now belongs to a different process incarnation, is reclaimed through an exclusive per-instance reclaim marker, so concurrent reclaimers can never remove a replacement lock.

Stored values must be JSON-safe so every store returns exactly what was saved: run input/context passed to `startRun` and dispatcher results may only contain plain objects, dense arrays, strings, booleans, `null`, and finite numbers. Non-JSON input is rejected with `WorkflowValueNotJsonSafeError`; a dispatcher result that is not JSON-safe is recorded as an `interrupted` run with `recoveryDisposition: "manual"` and a diagnostic instead of being altered or replayed.

Every logical run has an idempotency key. Dispatcher failures explicitly classified as `not-dispatched` can be recovered with the same run ID/key:

```ts
const recovery = await engine.recoverRuns();
console.log(recovery.recovered, recovery.ambiguous);
```

An unclassified dispatcher exception becomes `interrupted` with `manual` disposition and is not replayed automatically. A persisted `running` record is also reported through `recovery.ambiguous`, but recovery leaves it unchanged because another engine instance may still own the active dispatch. A dispatcher adapter that knows delivery never occurred may throw `WorkflowDispatchError(message, "not-dispatched")` to make that interruption retryable.

Cron scheduling commits the occurrence claim and its initial queued run in one store transaction, so a process cannot durably claim a minute without leaving a recoverable run. Dispatch/recovery similarly uses an atomic store claim before invoking the dispatcher, preventing two engine instances from executing the same queued run concurrently.

Scheduled occurrences may overlap (TECH-002). `tick()` claims and starts every matching occurrence synchronously, then resolves once those dispatches finish. A host should therefore call `tick()` for each minute **without awaiting earlier ticks**: a long-running occurrence must not delay the next one. Each occurrence gets its own run ID, idempotency key and pinned workflow version, and re-observing a minute, on any engine instance sharing the store or after a restart, never dispatches it twice. `src/cron-overlap.test.ts` proves this with an unresolved first run, using both the in-memory and the file store.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the next implementation slices and boundary constraints.

## Development

```sh
bun install
bun run verify
```

## Live run status

A dispatcher can report lifecycle events while a run executes. `dispatch(request, observer)` receives an optional second argument `{ onEvent(event) }`; the request itself stays plain data. Dispatchers that ignore the observer keep working unchanged. Events are structural, for example Runner's `node.started`, `node.succeeded`, `node.failed`, `node.skipped`, `node.retrying` and `node.suspended`, with `nodeId`, `attempt` and `timestamp`.

A connected host reads the current progress with these calls:

- `engine.getLiveRun(runId)` returns the run's identity (run, workflow and version), `status: "running"`, and one entry per node with its current state, attempt and update time.
- `engine.observeRun(runId, listener)` calls the listener on every change, and once more with the persisted terminal status. Listener errors never affect the run.

Live status is ephemeral and bounded:

- It is held in memory only, with one entry per node.
- Event payloads such as outputs are never retained.
- It is never written to the store.
- It is dropped once the terminal run record is persisted.

After a restart, only the durable run records and their recovery state remain.

## Human task waits

A dispatcher may return `{ status: "suspended", checkpoint }` (Runner #30 format). The engine then stores the run as `waiting`, with a `waiting` record holding:

- the node and task ID;
- the waiting node's compiled `humanTask` contract (workflow-editor #105);
- the task request;
- the JSON-safe checkpoint.

The runner is not kept active while the run waits.

- **Pending tasks:** `engine.listPendingTasks()` lists open tasks, and they survive a restart with the file store.
- **Responding:** `engine.respondToTask({ runId, taskId, response })` takes a response the host has already authorized, and the engine validates it:
  - structurally: approval needs `{ decision: "approved" | "rejected" }`, input needs `{ value }`, plus an optional text `comment` and a JSON payload;
  - with the optional `validateHumanTaskResponse` engine option, for example workflow-editor's `validateWorkflowEditorHumanTaskResponse` with the workflow's `typeDeclarations`.
- **Resuming:** the engine then atomically claims the task and dispatches `{ resume: { checkpoint, response } }` for the **same run** (same run ID, workflow version, digest and idempotency key).
- **Stale responses:** duplicate or concurrent responses throw `WorkflowTaskNotPendingError` and never dispatch a second continuation.
- **Invalid responses:** these throw `WorkflowTaskResponseInvalidError` and leave the task waiting.
- **Recovery:** waiting runs are never recovered or redispatched automatically.
