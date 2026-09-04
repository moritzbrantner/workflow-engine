# AGENTS.md

Apply the live coding-agent conventions for TypeScript, repository structure, dependencies, and testing.

## Boundary

`workflow-engine` owns immutable workflow registration/versioning, trigger definitions, run records, scheduling decisions, and dispatch to a runner-shaped interface.

It does not execute workflow nodes itself and must not import executor implementations. Keep the dependency on `workflow-runner` structural through `WorkflowRunDispatcher` so each repository remains independently developable in source mode.

The MVP store is in-memory. Persistence, durable queues, distributed workers, authentication, and deployment are later concerns.

Cron matching is evaluated in UTC and follows standard five-field day-of-month/day-of-week OR semantics when both fields are restricted.

## Validation

Use `bun run verify` for the canonical repository check. Keep behavior tests colocated with the smallest source scope they exercise.
