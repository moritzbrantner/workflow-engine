import type { WorkflowDispatchDeliveryState } from "./types.js";

export class WorkflowDispatchError extends Error {
  readonly code = "WORKFLOW_DISPATCH_ERROR" as const;
  readonly deliveryState: WorkflowDispatchDeliveryState;

  constructor(message: string, deliveryState: WorkflowDispatchDeliveryState) {
    super(message);
    this.name = "WorkflowDispatchError";
    this.deliveryState = deliveryState;
  }
}

export class WorkflowTaskNotPendingError extends Error {
  readonly code = "WORKFLOW_TASK_NOT_PENDING" as const;
  constructor(runId: string, taskId: string) {
    super(`Task ${taskId} of run ${runId} is not waiting for a response.`);
    this.name = "WorkflowTaskNotPendingError";
  }
}

export class WorkflowTaskResponseInvalidError extends Error {
  readonly code = "WORKFLOW_TASK_RESPONSE_INVALID" as const;
  readonly problems: readonly string[];
  constructor(taskId: string, problems: readonly string[]) {
    super(`Response to task ${taskId} is invalid: ${problems.join(" ")}`);
    this.name = "WorkflowTaskResponseInvalidError";
    this.problems = [...problems];
  }
}
