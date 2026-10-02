export class WorkflowDefinitionVersionConflictError extends Error {
  readonly code = "WORKFLOW_DEFINITION_VERSION_CONFLICT" as const;
  readonly workflowId: string;
  readonly version: number;

  constructor(workflowId: string, version: number) {
    super(`Workflow ${workflowId} version ${version} is already occupied by another definition.`);
    this.name = "WorkflowDefinitionVersionConflictError";
    this.workflowId = workflowId;
    this.version = version;
  }
}

export class WorkflowRunIdempotencyConflictError extends Error {
  readonly code = "WORKFLOW_RUN_IDEMPOTENCY_CONFLICT" as const;
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`Workflow run idempotency key ${idempotencyKey} is already bound to another run.`);
    this.name = "WorkflowRunIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}
