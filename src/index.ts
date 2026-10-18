import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  assertJsonSafe,
  assertOptionalJsonSafe,
  assertStorableRecord,
  withoutUndefinedFields,
} from "./json-value.js";
import { assertWorkflowRunTransition, prepareWorkflowRunForDispatch } from "./run-state.js";
import {
  WorkflowDefinitionVersionConflictError,
  WorkflowRunIdConflictError,
  WorkflowRunIdempotencyConflictError,
  WorkflowValueNotJsonSafeError,
} from "./store-errors.js";
import { assertExecutableWorkflow } from "./validation.js";

export { createFileWorkflowEngineStore } from "./file-store.js";
export type {
  WorkflowLiveNodeState,
  WorkflowLiveNodeStatus,
  WorkflowLiveRunListener,
  WorkflowLiveRunStatus,
  WorkflowRunLiveEvent,
} from "./live-runs.js";
import {
  WorkflowLiveRuns,
  type WorkflowLiveRunListener,
  type WorkflowLiveRunStatus,
  type WorkflowRunLiveEvent,
} from "./live-runs.js";
export { InvalidWorkflowRunTransitionError } from "./run-state.js";
export {
  WorkflowDefinitionVersionConflictError,
  WorkflowRunIdConflictError,
  WorkflowRunIdempotencyConflictError,
  WorkflowValueNotJsonSafeError,
} from "./store-errors.js";

export {
  InvalidExecutableWorkflowError,
  validateExecutableWorkflow,
  type ExecutableWorkflowDiagnostic,
  type ExecutableWorkflowDiagnosticCode,
  type ExecutableWorkflowValidationResult,
} from "./validation.js";

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
  /** 1 for plain DAGs; 2 when the workflow contains bounded iteration. */
  version: 1 | 2;
  nodes: ExecutableWorkflowNode[];
  edges: ExecutableWorkflowEdge[];
  order: string[];
  /** TypeScript declarations the compiled port types refer to (workflow-editor). */
  typeDeclarations?: string;
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

export class WorkflowDispatchError extends Error {
  readonly code = "WORKFLOW_DISPATCH_ERROR" as const;
  readonly deliveryState: WorkflowDispatchDeliveryState;

  constructor(message: string, deliveryState: WorkflowDispatchDeliveryState) {
    super(message);
    this.name = "WorkflowDispatchError";
    this.deliveryState = deliveryState;
  }
}

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

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createInMemoryWorkflowEngineStore(): WorkflowEngineStore {
  const definitions = new Map<string, WorkflowDefinition[]>();
  const triggers = new Map<string, WorkflowTrigger>();
  const scheduleClaims = new Set<string>();
  const runs = new Map<string, WorkflowRunRecord>();

  return {
    saveDefinition(definition) {
      assertStorableRecord(definition, "definition");
      const versions = definitions.get(definition.workflowId) ?? [];
      const existing = versions.find((item) => item.version === definition.version);
      if (existing) {
        if (
          existing.digest === definition.digest &&
          isDeepStrictEqual(existing.workflow, definition.workflow)
        ) {
          return clone(existing);
        }
        throw new WorkflowDefinitionVersionConflictError(definition.workflowId, definition.version);
      }

      const stored = withoutUndefinedFields(definition);
      const next = [...versions, clone(stored)].sort((a, b) => a.version - b.version);
      definitions.set(definition.workflowId, next);
      return clone(stored);
    },
    listDefinitions(workflowId) {
      return (definitions.get(workflowId) ?? []).map(clone);
    },
    saveTrigger(trigger) {
      assertStorableRecord(trigger, "trigger");
      const existing = triggers.get(trigger.id);
      if (existing && isDeepStrictEqual(existing, trigger)) {
        return;
      }
      triggers.set(trigger.id, clone(withoutUndefinedFields(trigger)));
    },
    getTrigger(triggerId) {
      const trigger = triggers.get(triggerId);
      return trigger ? clone(trigger) : undefined;
    },
    listTriggers() {
      return [...triggers.values()].map(clone);
    },
    claimSchedule(claim) {
      assertStorableRecord(claim, "scheduleClaim");
      const key = JSON.stringify([claim.triggerId, claim.scheduledAt]);
      if (scheduleClaims.has(key)) {
        return false;
      }
      scheduleClaims.add(key);
      return true;
    },
    claimScheduleRun(claim, run) {
      assertStorableRecord(claim, "scheduleClaim");
      assertStorableRecord(run, "run");
      const key = JSON.stringify([claim.triggerId, claim.scheduledAt]);
      if (scheduleClaims.has(key)) {
        return false;
      }
      if (runs.has(run.id)) {
        throw new WorkflowRunIdConflictError(run.id);
      }
      if (
        run.status !== "queued" ||
        run.dispatchAttempts !== 0 ||
        run.triggerId !== claim.triggerId ||
        run.idempotencyKey !== claim.idempotencyKey
      ) {
        throw new Error(
          "Scheduled workflow runs must start queued and match their schedule claim.",
        );
      }

      const sameKey = [...runs.values()].find(
        (candidate) => candidate.idempotencyKey === run.idempotencyKey,
      );
      if (sameKey && sameKey.id !== run.id) {
        throw new WorkflowRunIdempotencyConflictError(run.idempotencyKey);
      }
      assertWorkflowRunTransition(undefined, run);

      scheduleClaims.add(key);
      runs.set(run.id, clone(withoutUndefinedFields(run)));
      return true;
    },
    saveRun(run) {
      assertStorableRecord(run, "run");
      const sameKey = [...runs.values()].find(
        (candidate) => candidate.idempotencyKey === run.idempotencyKey,
      );
      if (sameKey && sameKey.id !== run.id) {
        throw new WorkflowRunIdempotencyConflictError(run.idempotencyKey);
      }

      const previous = runs.get(run.id);
      assertWorkflowRunTransition(previous, run);
      const stored = withoutUndefinedFields(run);
      if (previous && isDeepStrictEqual(previous, stored)) {
        return;
      }
      runs.set(run.id, clone(stored));
    },
    claimRunForDispatch(runId, startedAt, claimOptions) {
      const current = runs.get(runId);
      if (!current) {
        return undefined;
      }
      const claimed = prepareWorkflowRunForDispatch(current, startedAt, claimOptions);
      if (!claimed) {
        return undefined;
      }
      runs.set(runId, clone(claimed));
      return clone(claimed);
    },
    getRun(runId) {
      const run = runs.get(runId);
      return run ? clone(run) : undefined;
    },
    getRunByIdempotencyKey(idempotencyKey) {
      const run = [...runs.values()].find(
        (candidate) => candidate.idempotencyKey === idempotencyKey,
      );
      return run ? clone(run) : undefined;
    },
    listRuns() {
      return [...runs.values()]
        .map(clone)
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        );
    },
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function digestExecutableWorkflow(workflow: ExecutableWorkflow): string {
  return createHash("sha256").update(stableStringify(workflow)).digest("hex");
}

function normalizeTrigger(input: WorkflowTriggerInput, createId: () => string): WorkflowTrigger {
  const base = {
    id: input.id ?? createId(),
    workflowId: input.workflowId,
    ...(input.workflowVersion === undefined ? {} : { workflowVersion: input.workflowVersion }),
    enabled: input.enabled ?? true,
  };

  switch (input.type) {
    case "manual":
      return { ...base, type: "manual" };
    case "cron":
      assertValidCron(input.cron);
      return { ...base, type: "cron", cron: input.cron };
    case "webhook":
      if (!input.path.startsWith("/")) {
        throw new Error("Webhook trigger paths must start with '/'.");
      }
      return {
        ...base,
        type: "webhook",
        path: input.path,
        method: (input.method ?? "POST").toUpperCase(),
      };
  }
}

type CronField = {
  matches(value: number): boolean;
};

function parseCronNumber(value: string, min: number, max: number, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${field} cron value: ${value}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new Error(`Out-of-range ${field} cron value: ${value}`);
  }
  return parsed;
}

function parseCronField(expression: string, min: number, max: number, field: string): CronField {
  const accepted = new Set<number>();
  const parts = expression.split(",");
  if (parts.length === 0) {
    throw new Error(`Invalid ${field} cron field.`);
  }

  for (const part of parts) {
    const [base = "", stepText] = part.split("/");
    const step =
      stepText === undefined ? 1 : parseCronNumber(stepText, 1, max - min + 1, `${field} step`);
    let start = min;
    let end = max;

    if (base !== "*") {
      const range = base.split("-");
      if (range.length === 1) {
        start = parseCronNumber(range[0] ?? "", min, max, field);
        end = stepText === undefined ? start : max;
      } else if (range.length === 2) {
        start = parseCronNumber(range[0] ?? "", min, max, field);
        end = parseCronNumber(range[1] ?? "", min, max, field);
        if (start > end) {
          throw new Error(`Invalid ${field} cron range: ${base}`);
        }
      } else {
        throw new Error(`Invalid ${field} cron field: ${part}`);
      }
    }

    for (let value = start; value <= end; value += step) {
      accepted.add(value);
    }
  }

  return { matches: (value) => accepted.has(value) };
}

export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expressions must have five fields: minute hour day month weekday.");
  }
  const [minute, hour, day, month, weekday] = fields;
  if (!minute || !hour || !day || !month || !weekday) {
    throw new Error("Invalid cron expression.");
  }

  const dayField = parseCronField(day, 1, 31, "day");
  const weekdayField = parseCronField(weekday, 0, 7, "weekday");
  const weekdayValue = date.getUTCDay();
  const dayMatches = dayField.matches(date.getUTCDate());
  const weekdayMatches =
    weekdayField.matches(weekdayValue) || (weekdayValue === 0 && weekdayField.matches(7));
  let calendarDayMatches = dayMatches || weekdayMatches;
  if (day === "*") {
    calendarDayMatches = weekday === "*" || weekdayMatches;
  } else if (weekday === "*") {
    calendarDayMatches = dayMatches;
  }

  return (
    parseCronField(minute, 0, 59, "minute").matches(date.getUTCMinutes()) &&
    parseCronField(hour, 0, 23, "hour").matches(date.getUTCHours()) &&
    parseCronField(month, 1, 12, "month").matches(date.getUTCMonth() + 1) &&
    calendarDayMatches
  );
}

function assertValidCron(expression: string): void {
  matchesCron(expression, new Date("2026-01-01T00:00:00.000Z"));
}

function scheduledMinute(date: Date): string {
  const scheduledAt = new Date(date);
  scheduledAt.setUTCSeconds(0, 0);
  return scheduledAt.toISOString();
}

function scheduleIdempotencyKey(triggerId: string, scheduledAt: string): string {
  const digest = createHash("sha256")
    .update(stableStringify({ triggerId, scheduledAt }))
    .digest("hex");
  return `schedule:${digest}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the runner checkpoint's `waiting` and attaches the waiting node's compiled task. */
function waitFromCheckpoint(
  definition: WorkflowDefinition,
  checkpoint: unknown,
  since: string,
): WorkflowRunWait {
  const waiting = isPlainRecord(checkpoint) ? checkpoint.waiting : undefined;
  if (
    !isPlainRecord(waiting) ||
    typeof waiting.nodeId !== "string" ||
    typeof waiting.taskId !== "string"
  ) {
    throw new WorkflowDispatchError(
      "Dispatcher returned a suspension without a waiting node and task id.",
      "unknown",
    );
  }
  const node = definition.workflow.nodes.find((candidate) => candidate.id === waiting.nodeId);
  return {
    nodeId: waiting.nodeId,
    taskId: waiting.taskId,
    ...(node?.humanTask === undefined ? {} : { humanTask: clone(node.humanTask) }),
    ...(waiting.request === undefined ? {} : { request: clone(waiting.request) }),
    checkpoint: clone(checkpoint),
    since,
  };
}

/** Structural checks of the workflow-editor human task response contract (editor #105). */
function validateTaskResponse(humanTask: unknown, response: unknown): string[] {
  if (!isPlainRecord(response)) {
    return ["The response must be an object."];
  }
  const problems: string[] = [];
  try {
    assertJsonSafe(response, "response");
  } catch {
    problems.push("The response must be JSON.");
  }
  if (response.comment !== undefined && typeof response.comment !== "string") {
    problems.push("The response comment must be text.");
  }
  const kind = isPlainRecord(humanTask) ? humanTask.kind : undefined;
  if (kind === "approval" && response.decision !== "approved" && response.decision !== "rejected") {
    problems.push('The response decision must be "approved" or "rejected".');
  }
  if (kind === "input" && !Object.prototype.hasOwnProperty.call(response, "value")) {
    problems.push("The response needs a value.");
  }
  return problems;
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const store = options.store ?? createInMemoryWorkflowEngineStore();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  const resolveDefinition = (workflowId: string, version?: number): WorkflowDefinition => {
    const definitions = store.listDefinitions(workflowId);
    const definition =
      version === undefined
        ? definitions.at(-1)
        : definitions.find((candidate) => candidate.version === version);
    if (!definition) {
      throw new Error(
        version === undefined
          ? `Workflow ${workflowId} has no registered definition.`
          : `Workflow ${workflowId} version ${version} is not registered.`,
      );
    }
    return definition;
  };

  const activeRunIds = new Set<string>();
  const liveRuns = new WorkflowLiveRuns();

  const storedError = (error: unknown): unknown => {
    if (error instanceof WorkflowDispatchError) {
      return {
        code: error.code,
        message: error.message,
        deliveryState: error.deliveryState,
      };
    }
    if (error instanceof WorkflowValueNotJsonSafeError) {
      return { code: error.code, name: error.name, message: error.message, path: error.path };
    }
    if (error instanceof Error) {
      return { name: error.name, message: error.message };
    }
    try {
      assertJsonSafe(error, "error");
    } catch (unsafe) {
      if (!(unsafe instanceof WorkflowValueNotJsonSafeError)) {
        throw unsafe;
      }
      return { name: "NonJsonDispatchError", message: unsafe.message };
    }
    return clone(error);
  };

  const definitionForRun = (run: WorkflowRunRecord): WorkflowDefinition => {
    const definition = resolveDefinition(run.workflowId, run.workflowVersion);
    if (definition.digest !== run.workflowDigest) {
      throw new Error(
        `Workflow run ${run.id} is bound to digest ${run.workflowDigest}, but registered version ${definition.version} has digest ${definition.digest}.`,
      );
    }
    return definition;
  };

  type DispatchAttempt = {
    dispatched: boolean;
    run: WorkflowRunRecord;
  };

  const dispatchRun = async (
    definition: WorkflowDefinition,
    runId: string,
    resume?: { taskId: string; checkpoint: unknown; response: unknown },
  ): Promise<DispatchAttempt> => {
    const claimed = store.claimRunForDispatch(
      runId,
      now().toISOString(),
      resume ? { resumeTaskId: resume.taskId } : undefined,
    );
    if (!claimed) {
      const current = store.getRun(runId);
      if (!current) {
        throw new Error(`Workflow run ${runId} no longer exists.`);
      }
      return { dispatched: false, run: current };
    }

    let run = claimed;
    activeRunIds.add(run.id);
    liveRuns.begin(run.id, run.workflowId, run.workflowVersion);

    try {
      const runId = run.id;
      const result = await options.dispatcher.dispatch(
        {
          runId,
          workflow: clone(definition.workflow),
          input: clone(run.input),
          context: clone(run.context),
          idempotencyKey: run.idempotencyKey,
          ...(resume
            ? { resume: { checkpoint: clone(resume.checkpoint), response: clone(resume.response) } }
            : {}),
        },
        { onEvent: (event) => liveRuns.observe(runId, event) },
      );
      // Durable stores persist JSON; a result they cannot store faithfully is parked as a
      // manual interruption below instead of being silently altered or replayed.
      if (result.status === "succeeded") {
        assertOptionalJsonSafe(result.output, "output");
      }
      if (result.status === "failed") {
        assertOptionalJsonSafe(result.error, "error");
      }
      assertOptionalJsonSafe(result.events, "events");
      const finishedAt = now().toISOString();
      if (result.status === "suspended") {
        assertOptionalJsonSafe(result.checkpoint, "checkpoint");
        run = {
          ...run,
          status: "waiting",
          waiting: waitFromCheckpoint(definition, result.checkpoint, finishedAt),
          ...(result.events ? { events: clone(result.events) } : {}),
        };
      } else if (result.status === "succeeded") {
        run = {
          ...run,
          status: "succeeded",
          output: clone(result.output),
          ...(result.events ? { events: clone(result.events) } : {}),
          finishedAt,
        };
      } else if (result.status === "cancelled") {
        run = {
          ...run,
          status: "cancelled",
          ...(result.events ? { events: clone(result.events) } : {}),
          finishedAt,
        };
      } else {
        run = {
          ...run,
          status: "failed",
          error: clone(result.error),
          ...(result.events ? { events: clone(result.events) } : {}),
          failureKind: "workflow",
          finishedAt,
        };
      }
    } catch (error) {
      const retryable =
        error instanceof WorkflowDispatchError && error.deliveryState === "not-dispatched";
      run = {
        ...claimed,
        status: "interrupted",
        error: storedError(error),
        failureKind: "dispatch",
        recoveryDisposition: retryable ? "retryable" : "manual",
      };
    }

    try {
      run = withoutUndefinedFields(run);
      store.saveRun(run);
      return { dispatched: true, run: clone(run) };
    } finally {
      activeRunIds.delete(claimed.id);
      liveRuns.finish(claimed.id, run.status);
    }
  };

  const runMatchesRequest = (
    existing: WorkflowRunRecord,
    definition: WorkflowDefinition,
    input: StartWorkflowRunInput,
    runInput: Record<string, unknown>,
    context: Record<string, unknown>,
  ): boolean =>
    existing.workflowId === definition.workflowId &&
    existing.workflowVersion === definition.version &&
    existing.workflowDigest === definition.digest &&
    existing.triggerId === input.triggerId &&
    isDeepStrictEqual(existing.input, runInput) &&
    isDeepStrictEqual(existing.context, context);

  const existingIdempotentRun = (
    idempotencyKey: string,
    definition: WorkflowDefinition,
    input: StartWorkflowRunInput,
    runInput: Record<string, unknown>,
    context: Record<string, unknown>,
  ): WorkflowRunRecord | undefined => {
    const existing = store.getRunByIdempotencyKey(idempotencyKey);
    if (!existing) {
      return undefined;
    }
    if (!runMatchesRequest(existing, definition, input, runInput, context)) {
      throw new WorkflowRunIdempotencyConflictError(idempotencyKey);
    }
    return clone(existing);
  };

  const createQueuedRun = (
    definition: WorkflowDefinition,
    input: StartWorkflowRunInput,
  ): WorkflowRunRecord => {
    const id = createId();
    return {
      id,
      workflowId: definition.workflowId,
      workflowVersion: definition.version,
      workflowDigest: definition.digest,
      ...(input.triggerId ? { triggerId: input.triggerId } : {}),
      idempotencyKey: input.idempotencyKey ?? `run:${id}`,
      status: "queued",
      dispatchAttempts: 0,
      input: clone(input.input ?? {}),
      context: clone(input.context ?? {}),
      createdAt: now().toISOString(),
    };
  };

  const startRun = async (input: StartWorkflowRunInput): Promise<WorkflowRunRecord> => {
    const definition = resolveDefinition(input.workflowId, input.workflowVersion);
    assertJsonSafe(input.input ?? {}, "input");
    assertJsonSafe(input.context ?? {}, "context");
    const runInput = clone(input.input ?? {});
    const context = clone(input.context ?? {});

    if (input.idempotencyKey) {
      const existing = existingIdempotentRun(
        input.idempotencyKey,
        definition,
        input,
        runInput,
        context,
      );
      if (existing) {
        return existing;
      }
    }

    const run = createQueuedRun(definition, {
      ...input,
      input: runInput,
      context,
    });

    try {
      store.saveRun(run);
    } catch (error) {
      if (input.idempotencyKey && error instanceof WorkflowRunIdempotencyConflictError) {
        const existing = existingIdempotentRun(
          input.idempotencyKey,
          definition,
          input,
          runInput,
          context,
        );
        if (existing) {
          return existing;
        }
      }
      throw error;
    }

    return (await dispatchRun(definition, run.id)).run;
  };

  const recoverRuns = async (): Promise<WorkflowRecoveryResult> => {
    const recovered: WorkflowRunRecord[] = [];
    const ambiguous: WorkflowRunRecord[] = [];

    for (const persisted of store.listRuns()) {
      if (
        persisted.status === "queued" ||
        (persisted.status === "interrupted" && persisted.recoveryDisposition === "retryable")
      ) {
        const attempt = await dispatchRun(definitionForRun(persisted), persisted.id);
        if (attempt.dispatched) {
          recovered.push(attempt.run);
        }
        continue;
      }

      if (persisted.status === "running") {
        if (activeRunIds.has(persisted.id)) {
          continue;
        }
        ambiguous.push(clone(persisted));
        continue;
      }

      if (persisted.status === "interrupted") {
        ambiguous.push(clone(persisted));
      }
    }

    return { recovered, ambiguous };
  };

  return {
    registerWorkflow(input) {
      const workflow = assertExecutableWorkflow(input.workflow);
      // Validate before hashing: NaN or -0 would otherwise digest like null or 0 and dedupe
      // onto a different, already registered definition.
      assertJsonSafe(workflow, "workflow");
      const digest = digestExecutableWorkflow(workflow);

      for (let reservationAttempt = 0; reservationAttempt < 100; reservationAttempt += 1) {
        const versions = store.listDefinitions(input.workflowId);
        const existing = versions.find((definition) => definition.digest === digest);
        if (existing) {
          return clone(existing);
        }

        const latest = versions.at(-1);
        const definition: WorkflowDefinition = {
          workflowId: input.workflowId,
          version: (latest?.version ?? 0) + 1,
          digest,
          workflow: clone(workflow),
          createdAt: now().toISOString(),
        };

        try {
          return clone(store.saveDefinition(definition));
        } catch (error) {
          if (error instanceof WorkflowDefinitionVersionConflictError) {
            continue;
          }
          throw error;
        }
      }

      throw new Error(
        `Could not reserve a workflow version for ${input.workflowId} after repeated conflicts.`,
      );
    },

    registerTrigger(input) {
      resolveDefinition(input.workflowId, input.workflowVersion);
      const trigger = normalizeTrigger(input, createId);
      store.saveTrigger(trigger);
      return clone(trigger);
    },

    async fireTrigger(triggerId, input = {}) {
      const trigger = store.getTrigger(triggerId);
      if (!trigger) {
        throw new Error(`Trigger ${triggerId} is not registered.`);
      }
      if (!trigger.enabled) {
        throw new Error(`Trigger ${triggerId} is disabled.`);
      }
      if (trigger.type !== "manual") {
        throw new Error(`Trigger ${triggerId} is not a manual trigger.`);
      }
      return startRun({
        workflowId: trigger.workflowId,
        ...(trigger.workflowVersion === undefined
          ? {}
          : { workflowVersion: trigger.workflowVersion }),
        triggerId: trigger.id,
        input,
      });
    },

    startRun,
    recoverRuns,

    async handleWebhook(request) {
      const method = (request.method ?? "POST").toUpperCase();
      const triggers = store
        .listTriggers()
        .filter(
          (trigger): trigger is WebhookWorkflowTrigger =>
            trigger.type === "webhook" &&
            trigger.enabled &&
            trigger.path === request.path &&
            trigger.method === method,
        );
      const runs: WorkflowRunRecord[] = [];
      for (const trigger of triggers) {
        runs.push(
          await startRun({
            workflowId: trigger.workflowId,
            ...(trigger.workflowVersion === undefined
              ? {}
              : { workflowVersion: trigger.workflowVersion }),
            triggerId: trigger.id,
            input: {
              ...(request.body === undefined ? {} : { body: request.body }),
              headers: request.headers ?? {},
              query: request.query ?? {},
            },
          }),
        );
      }
      return runs;
    },

    async tick(tickDate = now()) {
      const scheduledAt = scheduledMinute(tickDate);
      const triggers = store
        .listTriggers()
        .filter(
          (trigger): trigger is CronWorkflowTrigger => trigger.type === "cron" && trigger.enabled,
        );
      const runs: WorkflowRunRecord[] = [];
      for (const trigger of triggers) {
        if (!matchesCron(trigger.cron, tickDate)) {
          continue;
        }

        const claim: WorkflowScheduleClaim = {
          triggerId: trigger.id,
          scheduledAt,
          idempotencyKey: scheduleIdempotencyKey(trigger.id, scheduledAt),
        };
        const definition = resolveDefinition(trigger.workflowId, trigger.workflowVersion);
        const queuedRun = createQueuedRun(definition, {
          workflowId: trigger.workflowId,
          ...(trigger.workflowVersion === undefined
            ? {}
            : { workflowVersion: trigger.workflowVersion }),
          triggerId: trigger.id,
          idempotencyKey: claim.idempotencyKey,
          input: { scheduledAt },
        });
        if (!store.claimScheduleRun(claim, queuedRun)) {
          continue;
        }

        runs.push((await dispatchRun(definition, queuedRun.id)).run);
      }
      return runs;
    },

    getRun(runId) {
      return store.getRun(runId);
    },
    listPendingTasks() {
      return store
        .listRuns()
        .flatMap((run) =>
          run.status === "waiting" && run.waiting
            ? [
                {
                  runId: run.id,
                  workflowId: run.workflowId,
                  workflowVersion: run.workflowVersion,
                  nodeId: run.waiting.nodeId,
                  taskId: run.waiting.taskId,
                  ...(run.waiting.humanTask === undefined
                    ? {}
                    : { humanTask: clone(run.waiting.humanTask) }),
                  ...(run.waiting.request === undefined
                    ? {}
                    : { request: clone(run.waiting.request) }),
                  since: run.waiting.since,
                },
              ]
            : [],
        )
        .sort((left, right) => left.since.localeCompare(right.since));
    },
    async respondToTask({ runId, taskId, response }) {
      const run = store.getRun(runId);
      if (!run || run.status !== "waiting" || run.waiting?.taskId !== taskId) {
        throw new WorkflowTaskNotPendingError(runId, taskId);
      }
      const definition = resolveDefinition(run.workflowId, run.workflowVersion);
      const problems = validateTaskResponse(run.waiting.humanTask, response);
      if (
        problems.length === 0 &&
        run.waiting.humanTask !== undefined &&
        options.validateHumanTaskResponse
      ) {
        problems.push(
          ...options.validateHumanTaskResponse(
            clone(run.waiting.humanTask),
            clone(response),
            definition.workflow.typeDeclarations === undefined
              ? {}
              : { typeDeclarations: definition.workflow.typeDeclarations },
          ),
        );
      }
      if (problems.length > 0) {
        throw new WorkflowTaskResponseInvalidError(taskId, problems);
      }
      const attempt = await dispatchRun(definition, runId, {
        taskId,
        checkpoint: run.waiting.checkpoint,
        response,
      });
      if (!attempt.dispatched) {
        // Another response or engine instance claimed the task first.
        throw new WorkflowTaskNotPendingError(runId, taskId);
      }
      return attempt.run;
    },
    getLiveRun(runId) {
      return liveRuns.get(runId);
    },
    observeRun(runId, listener) {
      return liveRuns.subscribe(runId, listener);
    },
    listRuns() {
      return store.listRuns();
    },
    listWorkflowVersions(workflowId) {
      return store.listDefinitions(workflowId);
    },
    listTriggers() {
      return store.listTriggers();
    },
  };
}
