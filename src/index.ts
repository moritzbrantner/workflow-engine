import { createHash, randomUUID } from "node:crypto";

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
  version: 1;
  nodes: ExecutableWorkflowNode[];
  edges: ExecutableWorkflowEdge[];
  order: string[];
};

export type WorkflowRunDispatchRequest = {
  runId: string;
  workflow: ExecutableWorkflow;
  input?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type WorkflowRunDispatchResult =
  | { status: "succeeded"; output: unknown; events?: readonly unknown[] }
  | { status: "failed"; error: unknown; events?: readonly unknown[] }
  | { status: "cancelled"; events?: readonly unknown[] };

export type WorkflowRunDispatcher = {
  dispatch(request: WorkflowRunDispatchRequest): Promise<WorkflowRunDispatchResult>;
};

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

export type WorkflowRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type WorkflowRunRecord = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  workflowDigest: string;
  triggerId?: string;
  status: WorkflowRunStatus;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  output?: unknown;
  error?: unknown;
  events?: readonly unknown[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type WorkflowEngineStore = {
  saveDefinition(definition: WorkflowDefinition): void;
  listDefinitions(workflowId: string): WorkflowDefinition[];
  saveTrigger(trigger: WorkflowTrigger): void;
  getTrigger(triggerId: string): WorkflowTrigger | undefined;
  listTriggers(): WorkflowTrigger[];
  saveRun(run: WorkflowRunRecord): void;
  getRun(runId: string): WorkflowRunRecord | undefined;
  listRuns(): WorkflowRunRecord[];
};

export type WorkflowEngineOptions = {
  dispatcher: WorkflowRunDispatcher;
  store?: WorkflowEngineStore;
  now?: () => Date;
  createId?: () => string;
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
  handleWebhook(request: WebhookRequest): Promise<WorkflowRunRecord[]>;
  tick(now?: Date): Promise<WorkflowRunRecord[]>;
  getRun(runId: string): WorkflowRunRecord | undefined;
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
  const runs = new Map<string, WorkflowRunRecord>();

  return {
    saveDefinition(definition) {
      const versions = definitions.get(definition.workflowId) ?? [];
      const next = versions.filter((item) => item.version !== definition.version);
      next.push(clone(definition));
      next.sort((a, b) => a.version - b.version);
      definitions.set(definition.workflowId, next);
    },
    listDefinitions(workflowId) {
      return (definitions.get(workflowId) ?? []).map(clone);
    },
    saveTrigger(trigger) {
      triggers.set(trigger.id, clone(trigger));
    },
    getTrigger(triggerId) {
      const trigger = triggers.get(triggerId);
      return trigger ? clone(trigger) : undefined;
    },
    listTriggers() {
      return [...triggers.values()].map(clone);
    },
    saveRun(run) {
      runs.set(run.id, clone(run));
    },
    getRun(runId) {
      const run = runs.get(runId);
      return run ? clone(run) : undefined;
    },
    listRuns() {
      return [...runs.values()]
        .map(clone)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${field} cron value: ${value}`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new Error(`Out-of-range ${field} cron value: ${value}`);
  }
  return parsed;
}

function parseCronField(expression: string, min: number, max: number, field: string): CronField {
  const accepted = new Set<number>();
  const parts = expression.split(",");
  if (parts.length === 0) throw new Error(`Invalid ${field} cron field.`);

  for (const part of parts) {
    const [base = "", stepText] = part.split("/");
    const step =
      stepText === undefined
        ? 1
        : parseCronNumber(stepText, 1, max - min + 1, `${field} step`);
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
        if (start > end) throw new Error(`Invalid ${field} cron range: ${base}`);
      } else {
        throw new Error(`Invalid ${field} cron field: ${part}`);
      }
    }

    for (let value = start; value <= end; value += step) accepted.add(value);
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
  const calendarDayMatches =
    day === "*" && weekday === "*"
      ? true
      : day === "*"
        ? weekdayMatches
        : weekday === "*"
          ? dayMatches
          : dayMatches || weekdayMatches;

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

function minuteKey(date: Date): string {
  return date.toISOString().slice(0, 16);
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const store = options.store ?? createInMemoryWorkflowEngineStore();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const lastCronFire = new Map<string, string>();

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

  const startRun = async (input: StartWorkflowRunInput): Promise<WorkflowRunRecord> => {
    const definition = resolveDefinition(input.workflowId, input.workflowVersion);
    const createdAt = now().toISOString();
    let run: WorkflowRunRecord = {
      id: createId(),
      workflowId: definition.workflowId,
      workflowVersion: definition.version,
      workflowDigest: definition.digest,
      ...(input.triggerId ? { triggerId: input.triggerId } : {}),
      status: "queued",
      input: clone(input.input ?? {}),
      context: clone(input.context ?? {}),
      createdAt,
    };
    store.saveRun(run);

    run = { ...run, status: "running", startedAt: now().toISOString() };
    store.saveRun(run);

    try {
      const result = await options.dispatcher.dispatch({
        runId: run.id,
        workflow: clone(definition.workflow),
        input: clone(run.input),
        context: clone(run.context),
      });
      const finishedAt = now().toISOString();
      if (result.status === "succeeded") {
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
          finishedAt,
        };
      }
      store.saveRun(run);
      return clone(run);
    } catch (error) {
      run = {
        ...run,
        status: "failed",
        error: clone(error),
        finishedAt: now().toISOString(),
      };
      store.saveRun(run);
      return clone(run);
    }
  };

  return {
    registerWorkflow(input) {
      const versions = store.listDefinitions(input.workflowId);
      const digest = digestExecutableWorkflow(input.workflow);
      const latest = versions.at(-1);
      if (latest?.digest === digest) return latest;

      const definition: WorkflowDefinition = {
        workflowId: input.workflowId,
        version: (latest?.version ?? 0) + 1,
        digest,
        workflow: clone(input.workflow),
        createdAt: now().toISOString(),
      };
      store.saveDefinition(definition);
      return clone(definition);
    },

    registerTrigger(input) {
      resolveDefinition(input.workflowId, input.workflowVersion);
      const trigger = normalizeTrigger(input, createId);
      store.saveTrigger(trigger);
      return clone(trigger);
    },

    async fireTrigger(triggerId, input = {}) {
      const trigger = store.getTrigger(triggerId);
      if (!trigger) throw new Error(`Trigger ${triggerId} is not registered.`);
      if (!trigger.enabled) throw new Error(`Trigger ${triggerId} is disabled.`);
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

    async handleWebhook(request) {
      const method = (request.method ?? "POST").toUpperCase();
      const triggers = store.listTriggers().filter(
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
              body: request.body,
              headers: request.headers ?? {},
              query: request.query ?? {},
            },
          }),
        );
      }
      return runs;
    },

    async tick(tickDate = now()) {
      const key = minuteKey(tickDate);
      const triggers = store
        .listTriggers()
        .filter(
          (trigger): trigger is CronWorkflowTrigger => trigger.type === "cron" && trigger.enabled,
        );
      const runs: WorkflowRunRecord[] = [];
      for (const trigger of triggers) {
        if (lastCronFire.get(trigger.id) === key || !matchesCron(trigger.cron, tickDate)) {
          continue;
        }
        lastCronFire.set(trigger.id, key);
        runs.push(
          await startRun({
            workflowId: trigger.workflowId,
            ...(trigger.workflowVersion === undefined
              ? {}
              : { workflowVersion: trigger.workflowVersion }),
            triggerId: trigger.id,
            input: { scheduledAt: tickDate.toISOString() },
          }),
        );
      }
      return runs;
    },

    getRun(runId) {
      return store.getRun(runId);
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
