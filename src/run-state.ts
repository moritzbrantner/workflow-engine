import { isDeepStrictEqual } from "node:util";

import type { WorkflowRunRecord, WorkflowRunStatus } from "./index.js";

export class InvalidWorkflowRunTransitionError extends Error {
  readonly code = "INVALID_WORKFLOW_RUN_TRANSITION" as const;
  readonly runId: string;
  readonly fromStatus: WorkflowRunStatus | undefined;
  readonly toStatus: WorkflowRunStatus;

  constructor(
    runId: string,
    fromStatus: WorkflowRunStatus | undefined,
    toStatus: WorkflowRunStatus,
    detail: string,
  ) {
    super(
      `Invalid workflow run transition for ${runId}: ${fromStatus ?? "<new>"} -> ${toStatus}: ${detail}`,
    );
    this.name = "InvalidWorkflowRunTransitionError";
    this.runId = runId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

const allowedTransitions: Readonly<Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>>> = {
  queued: new Set(["queued", "running", "cancelled"]),
  running: new Set(["running", "succeeded", "failed", "cancelled", "interrupted"]),
  interrupted: new Set(["interrupted", "running", "failed", "cancelled"]),
  succeeded: new Set(["succeeded"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
};

function immutableIdentity(run: WorkflowRunRecord) {
  return {
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    workflowDigest: run.workflowDigest,
    triggerId: run.triggerId,
    idempotencyKey: run.idempotencyKey,
    input: run.input,
    context: run.context,
    createdAt: run.createdAt,
  };
}

export function assertWorkflowRunTransition(
  previous: WorkflowRunRecord | undefined,
  next: WorkflowRunRecord,
): void {
  if (!previous) {
    if (next.status !== "queued") {
      throw new InvalidWorkflowRunTransitionError(
        next.id,
        undefined,
        next.status,
        "new runs must start queued",
      );
    }
    if (next.dispatchAttempts !== 0) {
      throw new InvalidWorkflowRunTransitionError(
        next.id,
        undefined,
        next.status,
        "new runs must start with zero dispatch attempts",
      );
    }
    return;
  }

  if (!isDeepStrictEqual(immutableIdentity(previous), immutableIdentity(next))) {
    throw new InvalidWorkflowRunTransitionError(
      next.id,
      previous.status,
      next.status,
      "run identity, workflow binding, input, context, and idempotency key are immutable",
    );
  }

  if (next.dispatchAttempts < previous.dispatchAttempts) {
    throw new InvalidWorkflowRunTransitionError(
      next.id,
      previous.status,
      next.status,
      "dispatch attempt count cannot decrease",
    );
  }

  if (!allowedTransitions[previous.status].has(next.status)) {
    throw new InvalidWorkflowRunTransitionError(
      next.id,
      previous.status,
      next.status,
      "the previous state is terminal or the transition is not recoverable",
    );
  }
}


export function prepareWorkflowRunForDispatch(
  current: WorkflowRunRecord,
  startedAt: string,
): WorkflowRunRecord | undefined {
  const claimable =
    current.status === "queued" ||
    (current.status === "interrupted" && current.recoveryDisposition === "retryable");
  if (!claimable) return undefined;

  const next = structuredClone(current);
  next.status = "running";
  next.dispatchAttempts += 1;
  next.startedAt ??= startedAt;
  delete next.output;
  delete next.error;
  delete next.events;
  delete next.failureKind;
  delete next.recoveryDisposition;
  delete next.finishedAt;
  assertWorkflowRunTransition(current, next);
  return next;
}
