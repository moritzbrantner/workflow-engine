import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { matchesCron } from "./cron.js";
import { digestExecutableWorkflow } from "./digest.js";
import {
  WorkflowDispatchError,
  WorkflowTaskNotPendingError,
  WorkflowTaskResponseInvalidError,
} from "./engine-errors.js";
import { validateTaskResponse, waitFromCheckpoint } from "./human-tasks.js";
import {
  assertJsonSafe,
  assertOptionalJsonSafe,
  clone,
  withoutUndefinedFields,
} from "./json-value.js";
import { WorkflowLiveRuns } from "./live-runs.js";
import { createInMemoryWorkflowEngineStore } from "./memory-store.js";
import {
  WorkflowDefinitionVersionConflictError,
  WorkflowRunIdempotencyConflictError,
  WorkflowValueNotJsonSafeError,
} from "./store-errors.js";
import { normalizeTrigger, scheduledMinute, scheduleIdempotencyKey } from "./triggers.js";
import type {
  CronWorkflowTrigger,
  StartWorkflowRunInput,
  WebhookWorkflowTrigger,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowEngineOptions,
  WorkflowRecoveryResult,
  WorkflowRunRecord,
  WorkflowScheduleClaim,
} from "./types.js";
import { assertExecutableWorkflow } from "./validation.js";

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
