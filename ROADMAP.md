# Workflow Engine Roadmap

The workflow engine owns workflow registration/versioning, triggers, scheduling, run records, and dispatch. It must not execute workflow nodes or absorb workflow-editor authoring behavior.

## P0 — Compiled workflow boundary

Status: compiled workflow values are validated at the runtime registration boundary before hashing or persistence. Version 1 validation returns stable structured diagnostics for malformed graph structure, duplicate ids, missing endpoints, invalid ports, and invalid order entries while preserving unknown forward-compatible node and port payload. The canonical editor fixture remains byte-for-semantics unchanged through registration and dispatch.

Related: #2.

## P0 — Durable schedule idempotency

Status: schedule occurrence claims now live behind `WorkflowEngineStore` and are taken atomically for `(triggerId, scheduled UTC minute)` before dispatch. Scheduled runs carry a deterministic idempotency key and a minute-normalized `scheduledAt`, so multiple engine instances sharing a store, engine recreation, and retry after dispatch failure cannot duplicate the same occurrence. The in-memory adapter retains claims for its own lifetime; a future persistent store can make the same contract survive process loss without changing engine scheduling semantics.

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
