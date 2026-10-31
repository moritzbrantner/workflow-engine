import type {
  WorkflowLiveRunListener,
  WorkflowLiveRunStatus,
  WorkflowRunLiveEvent,
} from "./live-runs.js";

export type ExecutableWorkflowPort = {
  id: string;
  optional?: boolean;
  defaultValue?: unknown;
};

export type ExecutableWorkflowNode = {
  id: string;
  label?: string;
  kind: string;
  inputs?: ExecutableWorkflowPort[];
  outputs?: ExecutableWorkflowPort[];
  data?: Record<string, unknown>;
  /**
   * Compiled-v2 bounded iteration (workflow-editor `control.iterate`). The engine validates its
   * structure and stores/dispatches it unchanged; the runner executes it.
   */
  iteration?: Record<string, unknown>;
  /** Compiled human task contract (workflow-editor `human.task.approval` / `human.task.input`). */
  humanTask?: unknown;
  /** Version 3 Workflow Reference; Runner executes it and enforces maxDepth. */
  workflowRef?: { workflow: string; maxDepth?: number };
};

export type ExecutableWorkflowEdge = {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
};

export type ExecutableWorkflow = {
  format: "@moritzbrantner/workflow/compiled";
  /** 1 for plain DAGs; 2 adds bounded iteration; 3 adds the Workflow Reference closure. */
  version: 1 | 2 | 3;
  nodes: ExecutableWorkflowNode[];
  edges: ExecutableWorkflowEdge[];
  order: string[];
  /** TypeScript declarations the compiled port types refer to (workflow-editor). */
  typeDeclarations?: string;
  /** Version 3: frozen referenced definitions keyed `<documentId>@<version>` (opaque here). */
  workflows?: Record<string, Record<string, unknown>>;
};

export type WorkflowRunDispatchRequest = {
  runId: string;
  workflow: ExecutableWorkflow;
  input?: Record<string, unknown>;
  context?: Record<string, unknown>;
  idempotencyKey: string;
  /** Continues the same run from its persisted checkpoint with the host's verified response. */
  resume?: { checkpoint: unknown; response: unknown };
};

/**
 * Optional live lifecycle observer passed beside the (plain data) dispatch request. Dispatchers
 * that support it report events while the run executes; the engine keeps them only as ephemeral
 * status. Dispatchers that ignore it keep working unchanged.
 */
export type WorkflowRunDispatchObserver = {
  onEvent(event: WorkflowRunLiveEvent): void;
};

export type WorkflowRunDispatchResult =
  | { status: "succeeded"; output: unknown; events?: readonly unknown[] }
  | { status: "failed"; error: unknown; events?: readonly unknown[] }
  | { status: "cancelled"; events?: readonly unknown[] }
  /**
   * The run paused at a waiting step (Engine TECH-001). `checkpoint` is the runner's JSON-safe
   * continuation; its `waiting` names the node, task id and request (Runner #30 format).
   */
  | { status: "suspended"; checkpoint: unknown; events?: readonly unknown[] };

export type WorkflowRunDispatcher = {
  dispatch(
    request: WorkflowRunDispatchRequest,
    observer?: WorkflowRunDispatchObserver,
  ): Promise<WorkflowRunDispatchResult>;
};

export type WorkflowDispatchDeliveryState = "not-dispatched" | "unknown";

export type WorkflowDefinition = {
  workflowId: string;
  version: number;
  digest: string;
  workflow: ExecutableWorkflow;
  createdAt: string;
};

export type WorkflowTriggerBase = {
  id: string;
  workflowId: string;
  workflowVersion?: number;
  enabled: boolean;
};

export type ManualWorkflowTrigger = WorkflowTriggerBase & {
  type: "manual";
};

export type CronWorkflowTrigger = WorkflowTriggerBase & {
  type: "cron";
  cron: string;
};

export type WebhookWorkflowTrigger = WorkflowTriggerBase & {
  type: "webhook";
  path: string;
  method: string;
};

export type WorkflowTrigger = ManualWorkflowTrigger | CronWorkflowTrigger | WebhookWorkflowTrigger;

export type WorkflowTriggerInput =
  | (Omit<ManualWorkflowTrigger, "id" | "enabled"> & { id?: string; enabled?: boolean })
  | (Omit<CronWorkflowTrigger, "id" | "enabled"> & { id?: string; enabled?: boolean })
  | (Omit<WebhookWorkflowTrigger, "id" | "enabled" | "method"> & {
      id?: string;
      enabled?: boolean;
      method?: string;
    });

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowRunFailureKind = "workflow" | "dispatch";
export type WorkflowRunRecoveryDisposition = "retryable" | "manual";

export type WorkflowScheduleClaim = {
  triggerId: string;
  scheduledAt: string;
  idempotencyKey: string;
};

export type WorkflowRunRecord = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  workflowDigest: string;
  triggerId?: string;
  idempotencyKey: string;
  status: WorkflowRunStatus;
  dispatchAttempts: number;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  output?: unknown;
  error?: unknown;
  events?: readonly unknown[];
  failureKind?: WorkflowRunFailureKind;
  recoveryDisposition?: WorkflowRunRecoveryDisposition;
  /** Present while the run is `waiting` for a human task (or another host-declared wait). */
  waiting?: WorkflowRunWait;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

/** The persisted wait of a suspended run (Engine TECH-001). */
export type WorkflowRunWait = {
  nodeId: string;
  taskId: string;
  /** Compiled human task contract of the waiting node (workflow-editor #105), when it has one. */
  humanTask?: unknown;
  request?: unknown;
  /** The runner's JSON-safe continuation checkpoint, dispatched back on resume. */
  checkpoint: unknown;
  since: string;
};

/** A waiting task a host can show to the person who may answer it. */
export type WorkflowPendingTask = {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  nodeId: string;
  taskId: string;
  humanTask?: unknown;
  request?: unknown;
  since: string;
};

export type RespondToWorkflowTaskInput = {
  runId: string;
  taskId: string;
  /** The host has already authorized the responder; the engine validates the payload. */
  response: unknown;
};

/**
 * Optional typed check for human input responses, e.g. workflow-editor's
 * `validateWorkflowEditorHumanTaskResponse`. Returns problem messages; empty means valid.
 */
export type WorkflowHumanTaskResponseValidator = (
  humanTask: unknown,
  response: unknown,
  options: { typeDeclarations?: string },
) => readonly string[];

export type WorkflowRunClaimOptions = {
  /** Claim a `waiting` run whose pending task has this id, exactly once, to resume it. */
  resumeTaskId?: string;
};

export type WorkflowEngineStore = {
  /**
   * Atomically reserves one workflow version.
   * Returns the persisted definition when the same version/digest already exists and throws
   * WorkflowDefinitionVersionConflictError when the version is occupied by different content.
   */
  saveDefinition(definition: WorkflowDefinition): WorkflowDefinition;
  listDefinitions(workflowId: string): WorkflowDefinition[];
  saveTrigger(trigger: WorkflowTrigger): void;
  getTrigger(triggerId: string): WorkflowTrigger | undefined;
  listTriggers(): WorkflowTrigger[];
  /**
   * Atomically claims one scheduled trigger occurrence.
   * Returns false when the same (triggerId, scheduledAt) occurrence was already claimed.
   */
  claimSchedule(claim: WorkflowScheduleClaim): boolean;
  /**
   * Atomically claims a schedule occurrence and persists its initial queued run.
   */
  claimScheduleRun(claim: WorkflowScheduleClaim, run: WorkflowRunRecord): boolean;
  saveRun(run: WorkflowRunRecord): void;
  /**
   * Atomically transitions a queued or retryable-interrupted run into a new running dispatch
   * attempt. Returns undefined when another owner already claimed or completed the run.
   */
  claimRunForDispatch(
    runId: string,
    startedAt: string,
    options?: WorkflowRunClaimOptions,
  ): WorkflowRunRecord | undefined;
  getRun(runId: string): WorkflowRunRecord | undefined;
  getRunByIdempotencyKey(idempotencyKey: string): WorkflowRunRecord | undefined;
  listRuns(): WorkflowRunRecord[];
};

export type WorkflowEngineOptions = {
  dispatcher: WorkflowRunDispatcher;
  store?: WorkflowEngineStore;
  now?: () => Date;
  createId?: () => string;
  /** Typed validation of human task responses; structural checks always apply. */
  validateHumanTaskResponse?: WorkflowHumanTaskResponseValidator;
};

export type RegisterWorkflowInput = {
  workflowId: string;
  workflow: ExecutableWorkflow;
};

export type StartWorkflowRunInput = {
  workflowId: string;
  workflowVersion?: number;
  triggerId?: string;
  input?: Record<string, unknown>;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
};

export type WorkflowRecoveryResult = {
  recovered: WorkflowRunRecord[];
  ambiguous: WorkflowRunRecord[];
};

export type WebhookRequest = {
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
};

export type WorkflowEngine = {
  registerWorkflow(input: RegisterWorkflowInput): WorkflowDefinition;
  registerTrigger(input: WorkflowTriggerInput): WorkflowTrigger;
  fireTrigger(triggerId: string, input?: Record<string, unknown>): Promise<WorkflowRunRecord>;
  startRun(input: StartWorkflowRunInput): Promise<WorkflowRunRecord>;
  recoverRuns(): Promise<WorkflowRecoveryResult>;
  handleWebhook(request: WebhookRequest): Promise<WorkflowRunRecord[]>;
  tick(now?: Date): Promise<WorkflowRunRecord[]>;
  getRun(runId: string): WorkflowRunRecord | undefined;
  /** Tasks of runs that are waiting for a response, oldest first. */
  listPendingTasks(): WorkflowPendingTask[];
  /**
   * Validates a host-authorized response, claims the waiting task exactly once and resumes the
   * same run from its checkpoint. Throws WorkflowTaskNotPendingError for stale or duplicate
   * responses and WorkflowTaskResponseInvalidError for a payload that fails validation.
   */
  respondToTask(input: RespondToWorkflowTaskInput): Promise<WorkflowRunRecord>;
  /** Live node progress of a run this engine is dispatching right now; ephemeral. */
  getLiveRun(runId: string): WorkflowLiveRunStatus | undefined;
  /**
   * Notifies `listener` on each live change of a run and once more with its persisted terminal
   * status. Returns an unsubscribe function. Listener errors never affect the run.
   */
  observeRun(runId: string, listener: WorkflowLiveRunListener): () => void;
  listRuns(): WorkflowRunRecord[];
  listWorkflowVersions(workflowId: string): WorkflowDefinition[];
  listTriggers(): WorkflowTrigger[];
};
