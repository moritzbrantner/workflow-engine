# Workflow Engine Roadmap

The workflow engine owns workflow registration/versioning, triggers, scheduling, run records, and dispatch. It must not execute workflow nodes or absorb workflow-editor authoring behavior.

## P0 — Compiled workflow boundary

Status: compiled workflow values are validated at the runtime registration boundary before hashing or persistence. Version 1 validation returns stable structured diagnostics for malformed graph structure, duplicate ids, missing endpoints, invalid ports, and invalid order entries while preserving unknown forward-compatible node and port payload. The canonical editor fixture remains byte-for-semantics unchanged through registration and dispatch.

Related: #2.

## P0 — Durable schedule idempotency

Status: schedule occurrence claims now live behind `WorkflowEngineStore` and are taken atomically for `(triggerId, scheduled UTC minute)` before dispatch. Scheduled runs carry a deterministic idempotency key and a minute-normalized `scheduledAt`, so multiple engine instances sharing a store, engine recreation, and retry after dispatch failure cannot duplicate the same occurrence. The in-memory adapter retains claims for its own lifetime; a future persistent store can make the same contract survive process loss without changing engine scheduling semantics.

## P1 — Durable storage and atomic version registration

Status: implemented by #9. The engine ships an atomic local JSON store in addition to the in-memory adapter. Definition reservation detects occupied versions and retries allocation without overwriting immutable definitions; schedule claims and run history survive restart; run identity is immutable; terminal state regressions are rejected; restart/idempotency/conflict regressions cover the store boundary.

## P1 — Explicit run cancellation and dispatch recovery

Status: dispatch recovery implemented by #10. Every run carries an idempotency key and dispatch-attempt count. Workflow failure is distinct from dispatch interruption; explicitly `not-dispatched` transport failures may be redelivered under the same logical run. Unknown-delivery interruptions are manual, while persisted `running` records are surfaced as ambiguous without mutation because another engine may still own the dispatch. Schedule claim + queued-run creation and dispatch acquisition are atomic store operations, preventing crash gaps and duplicate recovery execution.

Remaining slice:

- add cancellation as an engine-owned run lifecycle operation while runner remains responsible for execution cancellation mechanics.

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
