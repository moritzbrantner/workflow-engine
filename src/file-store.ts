import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertStorableRecord as assertStorable,
  withoutUndefinedFields,
} from "./json-value.js";
import {
  assertWorkflowRunTransition,
  prepareWorkflowRunForDispatch,
} from "./run-state.js";
import {
  WorkflowDefinitionVersionConflictError,
  WorkflowRunIdConflictError,
  WorkflowRunIdempotencyConflictError,
} from "./store-errors.js";
import type {
  WorkflowDefinition,
  WorkflowEngineStore,
  WorkflowRunRecord,
  WorkflowScheduleClaim,
  WorkflowTrigger,
} from "./index.js";

const FILE_STORE_SCHEMA_VERSION = 1 as const;
const LOCK_RETRY_MILLISECONDS = 5;
const LOCK_TIMEOUT_MILLISECONDS = 5_000;

type PersistedWorkflowEngineState = {
  schemaVersion: typeof FILE_STORE_SCHEMA_VERSION;
  definitions: WorkflowDefinition[];
  triggers: WorkflowTrigger[];
  scheduleClaims: WorkflowScheduleClaim[];
  runs: WorkflowRunRecord[];
};

function emptyState(): PersistedWorkflowEngineState {
  return {
    schemaVersion: FILE_STORE_SCHEMA_VERSION,
    definitions: [],
    triggers: [],
    scheduleClaims: [],
    runs: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseState(value: unknown, filePath: string): PersistedWorkflowEngineState {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== FILE_STORE_SCHEMA_VERSION ||
    !("definitions" in value) ||
    !Array.isArray(value.definitions) ||
    !("triggers" in value) ||
    !Array.isArray(value.triggers) ||
    !("scheduleClaims" in value) ||
    !Array.isArray(value.scheduleClaims) ||
    !("runs" in value) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error(`Workflow engine state at ${filePath} has an unsupported or malformed schema.`);
  }

  return clone(value as PersistedWorkflowEngineState);
}

function readState(filePath: string): PersistedWorkflowEngineState {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return emptyState();
    throw error;
  }

  try {
    return parseState(JSON.parse(contents) as unknown, filePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Workflow engine state at ${filePath} is not valid JSON: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeState(state: PersistedWorkflowEngineState): PersistedWorkflowEngineState {
  state.definitions.sort(
    (left, right) =>
      compareStrings(left.workflowId, right.workflowId) || left.version - right.version,
  );
  state.triggers.sort((left, right) => compareStrings(left.id, right.id));
  state.scheduleClaims.sort(
    (left, right) =>
      compareStrings(left.triggerId, right.triggerId) ||
      compareStrings(left.scheduledAt, right.scheduledAt),
  );
  state.runs.sort(
    (left, right) =>
      compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id),
  );
  return state;
}

let temporaryFileSequence = 0;

function writeState(filePath: string, state: PersistedWorkflowEngineState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  temporaryFileSequence += 1;
  const temporaryPath = `${filePath}.${process.pid}.${temporaryFileSequence}.tmp`;
  const serialized = `${JSON.stringify(canonicalizeState(clone(state)), null, 2)}\n`;

  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (!isErrno(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  }
}

function sleep(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

/**
 * Kernel start time of a process (Linux /proc/<pid>/stat field 22), which distinguishes process
 * incarnations that reuse a pid, e.g. a restarted container whose writer is pid 1 again.
 * Returns undefined where /proc is unavailable; liveness then falls back to the pid alone.
 */
function processStartTime(pid: number | "self"): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesised command name start at field 3 (state).
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

function lockOwnerIsAlive(pid: number, startTime: unknown): boolean {
  if (!processIsAlive(pid)) return false;
  if (typeof startTime !== "string") return true;
  const current = processStartTime(pid);
  return current === undefined || current === startTime;
}

type ObservedLockOwner = { raw: string; pid: number } | "missing" | "held";

function observeLockOwner(lockPath: string): ObservedLockOwner {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    return "held";
  }

  let owner: unknown;
  try {
    owner = JSON.parse(raw) as unknown;
  } catch {
    return "held";
  }
  if (
    typeof owner !== "object" ||
    owner === null ||
    Array.isArray(owner) ||
    !("pid" in owner) ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    lockOwnerIsAlive(owner.pid, "startTime" in owner ? owner.startTime : undefined)
  ) {
    return "held";
  }
  return { raw, pid: owner.pid };
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

/**
 * Removes the lock only if it is still the exact stale instance that was inspected.
 *
 * Every lock instance carries a unique owner record (pid, timestamp and token), and a reclaimer
 * must first create the exclusive reclaim marker for that instance. Only the marker holder may
 * unlink the instance, so after re-reading the lock under the marker it is guaranteed to still be
 * the stale instance and cannot be a replacement acquired by another process. A marker abandoned
 * by a reclaimer that died inside this short critical section is cleared after the lock timeout.
 */
function reclaimOrphanedLock(lockPath: string): boolean {
  const observed = observeLockOwner(lockPath);
  if (observed === "missing") return true;
  if (observed === "held") return false;

  const instance = createHash("sha256").update(observed.raw).digest("hex").slice(0, 32);
  const markerPath = `${lockPath}.reclaim-${instance}`;
  try {
    writeFileSync(markerPath, `${JSON.stringify({ pid: process.pid })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) return false;
    clearAbandonedReclaimMarker(markerPath);
    return false;
  }

  try {
    let current: string;
    try {
      current = readFileSync(lockPath, "utf8");
    } catch (error) {
      return isErrno(error, "ENOENT");
    }
    if (current !== observed.raw) return false;
    unlinkIfPresent(lockPath);
    return true;
  } finally {
    unlinkIfPresent(markerPath);
  }
}

function clearAbandonedReclaimMarker(markerPath: string): void {
  try {
    if (Date.now() - statSync(markerPath).mtimeMs > LOCK_TIMEOUT_MILLISECONDS) {
      unlinkIfPresent(markerPath);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

let lockOwnerSequence = 0;

/**
 * Publishes the lock with its ownership record already complete: the owner JSON is written to
 * a private file first and then hard-linked into place, which fails atomically with EEXIST when
 * the lock is held. A crash can leave only a private owner file behind, never a lock whose owner
 * cannot be determined.
 */
function publishLock(lockPath: string): void {
  lockOwnerSequence += 1;
  const ownerPath = `${lockPath}.${process.pid}.${lockOwnerSequence}.owner`;
  writeFileSync(
    ownerPath,
    `${JSON.stringify({
      pid: process.pid,
      startTime: processStartTime("self"),
      acquiredAt: new Date().toISOString(),
      token: randomUUID(),
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  try {
    linkSync(ownerPath, lockPath);
  } finally {
    unlinkSync(ownerPath);
  }
}

function withFileLock<T>(filePath: string, operation: () => T): T {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
  let acquired = false;

  while (!acquired) {
    try {
      publishLock(lockPath);
      acquired = true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw new Error(`Could not acquire workflow engine store lock ${lockPath}.`, {
          cause: error,
        });
      }
      if (reclaimOrphanedLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire workflow engine store lock ${lockPath}.`, {
          cause: error,
        });
      }
      sleep(LOCK_RETRY_MILLISECONDS);
    }
  }

  try {
    return operation();
  } finally {
    unlinkSync(lockPath);
  }
}

function mutateState<T>(
  filePath: string,
  mutation: (
    state: PersistedWorkflowEngineState,
  ) => { value: T; changed: boolean },
): T {
  return withFileLock(filePath, () => {
    const state = readState(filePath);
    const result = mutation(state);
    if (result.changed) writeState(filePath, state);
    return result.value;
  });
}

function sameScheduleClaim(left: WorkflowScheduleClaim, right: WorkflowScheduleClaim): boolean {
  return left.triggerId === right.triggerId && left.scheduledAt === right.scheduledAt;
}

export function createFileWorkflowEngineStore(path: string): WorkflowEngineStore {
  const filePath = resolve(path);

  return {
    saveDefinition(definition) {
      assertStorable(definition, "definition");
      return mutateState(filePath, (state) => {
        const existing = state.definitions.find(
          (candidate) =>
            candidate.workflowId === definition.workflowId &&
            candidate.version === definition.version,
        );
        if (existing) {
          if (
            existing.digest === definition.digest &&
            isDeepStrictEqual(existing.workflow, definition.workflow)
          ) {
            return { value: clone(existing), changed: false };
          }
          throw new WorkflowDefinitionVersionConflictError(
            definition.workflowId,
            definition.version,
          );
        }

        const stored = withoutUndefinedFields(definition);
        state.definitions.push(clone(stored));
        return { value: clone(stored), changed: true };
      });
    },

    listDefinitions(workflowId) {
      return readState(filePath)
        .definitions.filter((definition) => definition.workflowId === workflowId)
        .sort((left, right) => left.version - right.version)
        .map(clone);
    },

    saveTrigger(trigger) {
      assertStorable(trigger, "trigger");
      mutateState(filePath, (state) => {
        const index = state.triggers.findIndex((candidate) => candidate.id === trigger.id);
        if (index >= 0) {
          const existing = state.triggers[index];
          if (existing && isDeepStrictEqual(existing, trigger)) {
            return { value: undefined, changed: false };
          }
          state.triggers[index] = clone(trigger);
        } else {
          state.triggers.push(clone(trigger));
        }
        return { value: undefined, changed: true };
      });
    },

    getTrigger(triggerId) {
      const trigger = readState(filePath).triggers.find((candidate) => candidate.id === triggerId);
      return trigger ? clone(trigger) : undefined;
    },

    listTriggers() {
      return readState(filePath).triggers.sort((left, right) => compareStrings(left.id, right.id)).map(clone);
    },

    claimSchedule(claim) {
      assertStorable(claim, "scheduleClaim");
      return mutateState(filePath, (state) => {
        if (state.scheduleClaims.some((candidate) => sameScheduleClaim(candidate, claim))) {
          return { value: false, changed: false };
        }
        state.scheduleClaims.push(clone(claim));
        return { value: true, changed: true };
      });
    },

    claimScheduleRun(claim, run) {
      assertStorable(claim, "scheduleClaim");
      assertStorable(run, "run");
      return mutateState(filePath, (state) => {
        if (state.scheduleClaims.some((candidate) => sameScheduleClaim(candidate, claim))) {
          return { value: false, changed: false };
        }
        if (state.runs.some((candidate) => candidate.id === run.id)) {
          throw new WorkflowRunIdConflictError(run.id);
        }
        if (
          run.status !== "queued" ||
          run.dispatchAttempts !== 0 ||
          run.triggerId !== claim.triggerId ||
          run.idempotencyKey !== claim.idempotencyKey
        ) {
          throw new Error("Scheduled workflow runs must start queued and match their schedule claim.");
        }

        const sameKey = state.runs.find(
          (candidate) => candidate.idempotencyKey === run.idempotencyKey,
        );
        if (sameKey && sameKey.id !== run.id) {
          throw new WorkflowRunIdempotencyConflictError(run.idempotencyKey);
        }
        assertWorkflowRunTransition(undefined, run);

        state.scheduleClaims.push(clone(claim));
        state.runs.push(clone(run));
        return { value: true, changed: true };
      });
    },

    saveRun(run) {
      assertStorable(run, "run");
      mutateState(filePath, (state) => {
        const sameKey = state.runs.find(
          (candidate) => candidate.idempotencyKey === run.idempotencyKey,
        );
        if (sameKey && sameKey.id !== run.id) {
          throw new WorkflowRunIdempotencyConflictError(run.idempotencyKey);
        }

        const index = state.runs.findIndex((candidate) => candidate.id === run.id);
        const previous = index >= 0 ? state.runs[index] : undefined;
        assertWorkflowRunTransition(previous, run);
        if (previous && isDeepStrictEqual(previous, run)) {
          return { value: undefined, changed: false };
        }

        if (index >= 0) {
          state.runs[index] = clone(run);
        } else {
          state.runs.push(clone(run));
        }
        return { value: undefined, changed: true };
      });
    },

    claimRunForDispatch(runId, startedAt) {
      return mutateState(filePath, (state) => {
        const index = state.runs.findIndex((candidate) => candidate.id === runId);
        if (index < 0) return { value: undefined, changed: false };

        const current = state.runs[index];
        if (!current) return { value: undefined, changed: false };
        const claimed = prepareWorkflowRunForDispatch(current, startedAt);
        if (!claimed) return { value: undefined, changed: false };

        state.runs[index] = clone(claimed);
        return { value: clone(claimed), changed: true };
      });
    },

    getRun(runId) {
      const run = readState(filePath).runs.find((candidate) => candidate.id === runId);
      return run ? clone(run) : undefined;
    },

    getRunByIdempotencyKey(idempotencyKey) {
      const run = readState(filePath).runs.find(
        (candidate) => candidate.idempotencyKey === idempotencyKey,
      );
      return run ? clone(run) : undefined;
    },

    listRuns() {
      return readState(filePath)
        .runs.sort(
          (left, right) =>
            compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id),
        )
        .map(clone);
    },
  };
}
