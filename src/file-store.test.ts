import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileWorkflowEngineStore,
  createInMemoryWorkflowEngineStore,
  createWorkflowEngine,
  digestExecutableWorkflow,
  InvalidWorkflowRunTransitionError,
  WorkflowDefinitionVersionConflictError,
  WorkflowDispatchError,
  WorkflowRunIdempotencyConflictError,
  type ExecutableWorkflow,
  type WorkflowDefinition,
  type WorkflowEngineStore,
  type WorkflowRunRecord,
} from "./index";

const workflow: ExecutableWorkflow = {
  format: "@moritzbrantner/workflow/compiled",
  version: 1,
  nodes: [
    { id: "start", kind: "control.start", outputs: [{ id: "out" }] },
    { id: "end", kind: "control.end", inputs: [{ id: "in" }] },
  ],
  edges: [
    {
      id: "edge",
      sourceNodeId: "start",
      sourcePortId: "out",
      targetNodeId: "end",
      targetPortId: "in",
    },
  ],
  order: ["start", "end"],
};

function changedWorkflow(): ExecutableWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.id === "start" ? { ...node, label: "Changed" } : node,
    ),
  };
}

function deterministicIds(prefix: string) {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

test("file store survives restart without rewriting an already registered definition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-store-"));
  const filePath = join(directory, "state.json");

  try {
    const firstStore = createFileWorkflowEngineStore(filePath);
    const firstEngine = createWorkflowEngine({
      store: firstStore,
      createId: deterministicIds("first"),
      dispatcher: {
        async dispatch(request) {
          return { status: "succeeded", output: request.input ?? {} };
        },
      },
    });
    const definition = firstEngine.registerWorkflow({ workflowId: "durable", workflow });
    firstEngine.registerTrigger({
      id: "durable-cron",
      type: "cron",
      workflowId: "durable",
      cron: "* * * * *",
    });
    const firstRuns = await firstEngine.tick(new Date("2026-09-24T01:05:30.000Z"));
    assert.equal(firstRuns.length, 1);
    assert.equal(firstRuns[0]?.status, "succeeded");

    const beforeReregister = readFileSync(filePath, "utf8");
    const reopenedStore = createFileWorkflowEngineStore(filePath);
    const reopenedEngine = createWorkflowEngine({
      store: reopenedStore,
      createId: deterministicIds("reopened"),
      dispatcher: {
        async dispatch(request) {
          return { status: "succeeded", output: request.input ?? {} };
        },
      },
    });
    const duplicate = reopenedEngine.registerWorkflow({
      workflowId: "durable",
      workflow: structuredClone(workflow),
    });

    assert.equal(duplicate.version, definition.version);
    assert.equal(duplicate.digest, definition.digest);
    assert.equal(readFileSync(filePath, "utf8"), beforeReregister);
    assert.equal(reopenedEngine.listTriggers().length, 1);
    assert.equal(reopenedEngine.listRuns().length, 1);
    assert.deepEqual(await reopenedEngine.tick(new Date("2026-09-24T01:05:50.000Z")), []);

    const nextMinute = await reopenedEngine.tick(new Date("2026-09-24T01:06:10.000Z"));
    assert.equal(nextMinute.length, 1);
    assert.notEqual(nextMinute[0]?.idempotencyKey, firstRuns[0]?.idempotencyKey);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file store rejects conflicting definition versions and duplicate run idempotency keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-conflicts-"));
  const filePath = join(directory, "state.json");

  try {
    const store = createFileWorkflowEngineStore(filePath);
    const first: WorkflowDefinition = {
      workflowId: "demo",
      version: 1,
      digest: digestExecutableWorkflow(workflow),
      workflow,
      createdAt: "2026-09-24T01:00:00.000Z",
    };
    store.saveDefinition(first);

    assert.throws(
      () =>
        store.saveDefinition({
          ...first,
          digest: digestExecutableWorkflow(changedWorkflow()),
          workflow: changedWorkflow(),
        }),
      WorkflowDefinitionVersionConflictError,
    );

    const run: WorkflowRunRecord = {
      id: "run-1",
      workflowId: "demo",
      workflowVersion: 1,
      workflowDigest: first.digest,
      idempotencyKey: "evaluation:1",
      status: "queued",
      dispatchAttempts: 0,
      input: {},
      context: {},
      createdAt: "2026-09-24T01:00:00.000Z",
    };
    store.saveRun(run);

    assert.throws(
      () => store.saveRun({ ...run, id: "run-2" }),
      WorkflowRunIdempotencyConflictError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file store rejects terminal run-state regressions", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-transitions-"));
  const filePath = join(directory, "state.json");

  try {
    const store = createFileWorkflowEngineStore(filePath);
    const queued: WorkflowRunRecord = {
      id: "run-1",
      workflowId: "demo",
      workflowVersion: 1,
      workflowDigest: "digest:1",
      idempotencyKey: "run:1",
      status: "queued",
      dispatchAttempts: 0,
      input: {},
      context: {},
      createdAt: "2026-09-24T01:00:00.000Z",
    };
    const running: WorkflowRunRecord = {
      ...queued,
      status: "running",
      dispatchAttempts: 1,
      startedAt: "2026-09-24T01:00:01.000Z",
    };
    const succeeded: WorkflowRunRecord = {
      ...running,
      status: "succeeded",
      output: { ok: true },
      finishedAt: "2026-09-24T01:00:02.000Z",
    };

    store.saveRun(queued);
    store.saveRun(running);
    store.saveRun(succeeded);

    assert.throws(
      () => store.saveRun({ ...succeeded, status: "running" }),
      InvalidWorkflowRunTransitionError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("engine retries version reservation after an atomic store conflict", () => {
  const underlying = createInMemoryWorkflowEngineStore();
  let injectConflict = true;
  const conflictStore: WorkflowEngineStore = {
    ...underlying,
    saveDefinition(definition) {
      if (injectConflict) {
        injectConflict = false;
        const occupiedWorkflow = changedWorkflow();
        underlying.saveDefinition({
          ...definition,
          digest: digestExecutableWorkflow(occupiedWorkflow),
          workflow: occupiedWorkflow,
        });
        throw new WorkflowDefinitionVersionConflictError(
          definition.workflowId,
          definition.version,
        );
      }
      return underlying.saveDefinition(definition);
    },
  };

  const engine = createWorkflowEngine({
    store: conflictStore,
    dispatcher: {
      async dispatch() {
        return { status: "succeeded", output: {} };
      },
    },
  });
  const registered = engine.registerWorkflow({ workflowId: "contended", workflow });

  assert.equal(registered.version, 2);
  assert.equal(engine.listWorkflowVersions("contended").length, 2);
});

test("restart marks a previously running dispatch as ambiguous instead of replaying it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-ambiguous-"));
  const filePath = join(directory, "state.json");

  try {
    const store = createFileWorkflowEngineStore(filePath);
    const definition = store.saveDefinition({
      workflowId: "demo",
      version: 1,
      digest: digestExecutableWorkflow(workflow),
      workflow,
      createdAt: "2026-09-24T01:00:00.000Z",
    });
    const queued: WorkflowRunRecord = {
      id: "run-interrupted",
      workflowId: "demo",
      workflowVersion: 1,
      workflowDigest: definition.digest,
      idempotencyKey: "run:interrupted",
      status: "queued",
      dispatchAttempts: 0,
      input: { sourceId: "source-1" },
      context: {},
      createdAt: "2026-09-24T01:00:00.000Z",
    };
    store.saveRun(queued);
    store.saveRun({
      ...queued,
      status: "running",
      dispatchAttempts: 1,
      startedAt: "2026-09-24T01:00:01.000Z",
    });

    let redispatches = 0;
    const restarted = createWorkflowEngine({
      store: createFileWorkflowEngineStore(filePath),
      dispatcher: {
        async dispatch() {
          redispatches += 1;
          return { status: "succeeded", output: {} };
        },
      },
    });
    const recovery = await restarted.recoverRuns();

    assert.equal(redispatches, 0);
    assert.equal(recovery.recovered.length, 0);
    assert.equal(recovery.ambiguous.length, 1);
    assert.equal(recovery.ambiguous[0]?.status, "running");
    assert.equal(
      restarted.getRun("run-interrupted")?.status,
      "running",
      "recovery must not mutate a possibly-active dispatch owned by another engine",
    );

    const secondRecovery = await restarted.recoverRuns();
    assert.equal(secondRecovery.recovered.length, 0);
    assert.equal(secondRecovery.ambiguous.length, 1);
    assert.equal(redispatches, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("retryable dispatch interruption survives a durable store reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-retryable-"));
  const filePath = join(directory, "state.json");

  try {
    const first = createWorkflowEngine({
      store: createFileWorkflowEngineStore(filePath),
      createId: deterministicIds("durable-retry"),
      dispatcher: {
        async dispatch() {
          throw new WorkflowDispatchError("queue unavailable", "not-dispatched");
        },
      },
    });
    const definition = first.registerWorkflow({ workflowId: "evaluation", workflow });
    const interrupted = await first.startRun({
      workflowId: "evaluation",
      idempotencyKey: "evaluation:durable",
      input: { sourceId: "source-1" },
    });

    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.recoveryDisposition, "retryable");
    assert.equal(interrupted.workflowDigest, definition.digest);

    const deliveries: Array<{ runId: string; idempotencyKey: string }> = [];
    const restarted = createWorkflowEngine({
      store: createFileWorkflowEngineStore(filePath),
      dispatcher: {
        async dispatch(request) {
          deliveries.push({
            runId: request.runId,
            idempotencyKey: request.idempotencyKey,
          });
          return { status: "succeeded", output: { ok: true } };
        },
      },
    });

    const recovery = await restarted.recoverRuns();
    assert.equal(recovery.ambiguous.length, 0);
    assert.equal(recovery.recovered.length, 1);
    assert.equal(recovery.recovered[0]?.id, interrupted.id);
    assert.equal(recovery.recovered[0]?.workflowDigest, definition.digest);
    assert.equal(recovery.recovered[0]?.dispatchAttempts, 2);
    assert.deepEqual(deliveries, [
      {
        runId: interrupted.id,
        idempotencyKey: interrupted.idempotencyKey,
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
