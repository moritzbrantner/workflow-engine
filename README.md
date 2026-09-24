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

The file store atomically replaces a canonical JSON state file and serializes mutations through a lock file. Workflow-version reservation is conflict-aware, schedule claims survive restart, run identity is immutable, and terminal run states cannot regress.

Every logical run has an idempotency key. Dispatcher failures explicitly classified as `not-dispatched` can be recovered with the same run ID/key:

```ts
const recovery = await engine.recoverRuns();
console.log(recovery.recovered, recovery.ambiguous);
```

An unclassified dispatcher exception becomes `interrupted` with `manual` disposition and is not replayed automatically. A persisted `running` record is also reported through `recovery.ambiguous`, but recovery leaves it unchanged because another engine instance may still own the active dispatch. A dispatcher adapter that knows delivery never occurred may throw `WorkflowDispatchError(message, "not-dispatched")` to make that interruption retryable.

Cron scheduling commits the occurrence claim and its initial queued run in one store transaction, so a process cannot durably claim a minute without leaving a recoverable run. Dispatch/recovery similarly uses an atomic store claim before invoking the dispatcher, preventing two engine instances from executing the same queued run concurrently.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the next implementation slices and boundary constraints.

## Development

```sh
bun install
bun run verify
```
