# workflow-engine

Workflow orchestration service for versioned definitions, triggers, runs, scheduling, and runner dispatch.

## MVP

The engine stores immutable compiled workflow versions and run history in memory, supports manual, webhook, and five-field UTC cron triggers, and dispatches runs through a small structural `WorkflowRunDispatcher` interface.

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

This MVP is deliberately single-process. The store and dispatcher are explicit boundaries so persistent storage and queue-backed dispatch can replace the in-memory pieces later without changing workflow documents.

## Development

```sh
bun install
bun run verify
```
