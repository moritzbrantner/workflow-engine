import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { assertWorkflowRunTransition } from "./run-state.js";
import {
  WorkflowDefinitionVersionConflictError,
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

function withFileLock<T>(filePath: string, operation: () => T): T {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
  let lockDescriptor: number | undefined;

  while (lockDescriptor === undefined) {
    try {
      lockDescriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isErrno(error, "EEXIST") || Date.now() >= deadline) {
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
    closeSync(lockDescriptor);
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

        state.definitions.push(clone(definition));
        return { value: clone(definition), changed: true };
      });
    },

    listDefinitions(workflowId) {
      return readState(filePath)
        .definitions.filter((definition) => definition.workflowId === workflowId)
        .sort((left, right) => left.version - right.version)
        .map(clone);
    },

    saveTrigger(trigger) {
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
      return mutateState(filePath, (state) => {
        if (state.scheduleClaims.some((candidate) => sameScheduleClaim(candidate, claim))) {
          return { value: false, changed: false };
        }
        state.scheduleClaims.push(clone(claim));
        return { value: true, changed: true };
      });
    },

    saveRun(run) {
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
