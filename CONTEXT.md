# Workflow Engine Context

A **workflow definition** is an immutable registered copy of one compiled workflow. A changed digest creates a new monotonically increasing version; registering the same definition again is idempotent.

A **trigger** references a workflow and optionally pins a version. Unpinned triggers resolve the latest version when they fire.

A **run record** pins the exact workflow version and digest it dispatched, carries one stable idempotency key across dispatch attempts, and has monotonic lifecycle transitions. `interrupted` means the engine cannot safely claim execution completed or failed; only interruptions explicitly proven `not-dispatched` are automatically retryable. The engine supports manual, webhook, and five-field UTC cron triggers.

A **dispatcher** is the engine/runner boundary. `workflow-runner` satisfies this interface structurally, so `workflow-engine` has no source or package dependency on the private runner repository.


A **durable store** is still an engine-owned adapter. The built-in file store is for restart-safe local/single-process deployments; distributed queue or worker semantics remain outside the store contract.
