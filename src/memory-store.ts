import { isDeepStrictEqual } from "node:util";

import { assertStorableRecord, clone, withoutUndefinedFields } from "./json-value.js";
import { assertWorkflowRunTransition, prepareWorkflowRunForDispatch } from "./run-state.js";
import {
  WorkflowDefinitionVersionConflictError,
  WorkflowRunIdConflictError,
  WorkflowRunIdempotencyConflictError,
} from "./store-errors.js";
import type {
  WorkflowDefinition,
  WorkflowEngineStore,
  WorkflowRunRecord,
  WorkflowTrigger,
} from "./types.js";

export function createInMemoryWorkflowEngineStore(): WorkflowEngineStore {
  const definitions = new Map<string, WorkflowDefinition[]>();
  const triggers = new Map<string, WorkflowTrigger>();
  const scheduleClaims = new Set<string>();
  const runs = new Map<string, WorkflowRunRecord>();
  // A run's idempotency key is immutable (assertWorkflowRunTransition), so entries never go stale.
  const runIdsByIdempotencyKey = new Map<string, string>();

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

      const sameKeyRunId = runIdsByIdempotencyKey.get(run.idempotencyKey);
      if (sameKeyRunId !== undefined && sameKeyRunId !== run.id) {
        throw new WorkflowRunIdempotencyConflictError(run.idempotencyKey);
      }
      assertWorkflowRunTransition(undefined, run);

      scheduleClaims.add(key);
      runs.set(run.id, clone(withoutUndefinedFields(run)));
      runIdsByIdempotencyKey.set(run.idempotencyKey, run.id);
      return true;
    },
    saveRun(run) {
      assertStorableRecord(run, "run");
      const sameKeyRunId = runIdsByIdempotencyKey.get(run.idempotencyKey);
      if (sameKeyRunId !== undefined && sameKeyRunId !== run.id) {
        throw new WorkflowRunIdempotencyConflictError(run.idempotencyKey);
      }

      const previous = runs.get(run.id);
      assertWorkflowRunTransition(previous, run);
      const stored = withoutUndefinedFields(run);
      if (previous && isDeepStrictEqual(previous, stored)) {
        return;
      }
      runs.set(run.id, clone(stored));
      runIdsByIdempotencyKey.set(run.idempotencyKey, run.id);
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
      const runId = runIdsByIdempotencyKey.get(idempotencyKey);
      const run = runId === undefined ? undefined : runs.get(runId);
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
