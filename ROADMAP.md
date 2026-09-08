# Workflow Engine Roadmap

The workflow engine owns workflow registration/versioning, triggers, scheduling, run records, and dispatch. It must not execute workflow nodes or absorb workflow-editor authoring behavior.

## P0 — Compiled workflow boundary

Status: the MVP accepts `@moritzbrantner/workflow/compiled` version 1 and the cross-repository conformance fixture pins the current editor → engine handoff.

Next slice:

- validate compiled workflow values at the runtime boundary before hashing or persisting them;
- return stable structured diagnostics for unsupported versions, malformed nodes/edges/order, duplicate ids, missing endpoints, and invalid ports;
- keep validation deterministic and side-effect free;
- preserve unknown forward-compatible node data without weakening the versioned envelope;
- verify the canonical editor fixture can be registered, deduplicated, pinned to a run, and dispatched byte-for-semantics unchanged.

Related: #2.

## P0 — Durable schedule idempotency

The MVP prevents a cron trigger from firing twice in the same minute only inside one process. Restarts or multiple engine instances can therefore duplicate scheduled runs.

Next slice:

- move schedule claims behind `WorkflowEngineStore`;
- claim `(triggerId, scheduled UTC minute)` atomically before dispatch;
- give a scheduled run a deterministic idempotency key independent of process memory;
- make replay after restart safe;
- add tests for two engine instances sharing one store and for restart/retry scenarios.

## P1 — Durable storage and atomic version registration

- add a persistent store adapter without changing the engine API;
- make workflow-version allocation atomic under concurrent registration;
- keep workflow definitions immutable once registered;
- add store conformance tests that every adapter must pass;
- make run state transitions monotonic and reject invalid regressions.

## P1 — Explicit run cancellation and dispatch recovery

- add cancellation as an engine-owned run lifecycle operation while runner remains responsible for execution cancellation mechanics;
- define dispatch idempotency for retried queue delivery;
- preserve the exact workflow version/digest across retries;
- distinguish dispatch transport failure from workflow execution failure;
- support recovery of runs left in queued/running states after process interruption.

## P1 — Queue-backed dispatcher adapter

- keep `WorkflowRunDispatcher` as the boundary;
- add a queue-backed adapter with leases/visibility timeouts and idempotent delivery;
- do not import runner internals into the engine;
- prove an in-process runner and a queue-backed runner satisfy the same dispatcher contract.

## P2 — Operational query and retention surface

- query runs by workflow, trigger, status, and time range;
- expose deterministic event/run summaries suitable for APIs and GitHub Pages;
- define retention/archive hooks without coupling the engine to one database;
- add bounded pagination rather than unbounded list operations.

## Explicit non-goals

- Node execution and executor plugins belong to `workflow-runner`.
- Workflow authoring, graph editing, and compilation belong to `workflow-editor`.
- A distributed worker implementation is an adapter behind the dispatcher boundary, not engine core semantics.
