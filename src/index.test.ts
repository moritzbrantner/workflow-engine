import assert from "node:assert/strict";
import test from "node:test";

import {
  createInMemoryWorkflowEngineStore,
  createWorkflowEngine,
  matchesCron,
  WorkflowDispatchError,
  WorkflowRunIdempotencyConflictError,
  type ExecutableWorkflow,
  type WorkflowRunDispatchRequest,
  type WorkflowRunDispatcher,
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

function createDispatcher(): WorkflowRunDispatcher {
  return {
    async dispatch(request) {
      return { status: "succeeded", output: request.input ?? {} };
    },
  };
}

function deterministicIds(prefix = "id") {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

test("versions immutable workflow definitions", () => {
  const engine = createWorkflowEngine({
    dispatcher: createDispatcher(),
    createId: deterministicIds(),
  });

  const first = engine.registerWorkflow({ workflowId: "demo", workflow });
  const duplicate = engine.registerWorkflow({
    workflowId: "demo",
    workflow: structuredClone(workflow),
  });
  const changed = engine.registerWorkflow({
    workflowId: "demo",
    workflow: {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.id === "start" ? { ...node, label: "Start" } : node,
      ),
    },
  });

  assert.equal(first.version, 1);
  assert.equal(duplicate.version, 1);
  assert.equal(changed.version, 2);
  assert.notEqual(first.digest, changed.digest);
});

test("dispatches manual, webhook, and cron runs", async () => {
  const engine = createWorkflowEngine({
    dispatcher: createDispatcher(),
    createId: deterministicIds(),
  });
  engine.registerWorkflow({ workflowId: "demo", workflow });
  const manual = engine.registerTrigger({ type: "manual", workflowId: "demo" });
  engine.registerTrigger({ type: "webhook", workflowId: "demo", path: "/hooks/demo" });
  engine.registerTrigger({ type: "cron", workflowId: "demo", cron: "5 12 * * *" });

  const manualRun = await engine.fireTrigger(manual.id, { source: "manual" });
  assert.equal(manualRun.status, "succeeded");
  assert.deepEqual(manualRun.output, { source: "manual" });

  const webhookRuns = await engine.handleWebhook({
    path: "/hooks/demo",
    body: { source: "webhook" },
  });
  assert.equal(webhookRuns.length, 1);
  assert.deepEqual(webhookRuns[0]?.output, {
    body: { source: "webhook" },
    headers: {},
    query: {},
  });

  const date = new Date("2026-08-27T12:05:00.000Z");
  assert.equal((await engine.tick(date)).length, 1);
  assert.equal((await engine.tick(date)).length, 0);
});

test("matches five-field cron expressions in UTC", () => {
  assert.equal(matchesCron("*/5 12 * * *", new Date("2026-08-27T12:10:00.000Z")), true);
  assert.equal(matchesCron("*/5 12 * * *", new Date("2026-08-27T12:11:00.000Z")), false);
  assert.equal(matchesCron("0 0 * * 7", new Date("2026-08-30T00:00:00.000Z")), true);
});


test("claims a cron occurrence once across engine instances and restarts", async () => {
  const store = createInMemoryWorkflowEngineStore();
  const dispatched: WorkflowRunDispatchRequest[] = [];
  const dispatcher: WorkflowRunDispatcher = {
    async dispatch(request) {
      dispatched.push(structuredClone(request));
      return { status: "succeeded", output: request.input ?? {} };
    },
  };

  const engineA = createWorkflowEngine({
    dispatcher,
    store,
    createId: deterministicIds("engine-a"),
  });
  engineA.registerWorkflow({ workflowId: "shared-cron", workflow });
  engineA.registerTrigger({
    id: "shared-cron-trigger",
    type: "cron",
    workflowId: "shared-cron",
    cron: "* * * * *",
  });

  const engineB = createWorkflowEngine({
    dispatcher,
    store,
    createId: deterministicIds("engine-b"),
  });

  const firstObservation = new Date("2026-08-27T12:05:01.000Z");
  const secondObservation = new Date("2026-08-27T12:05:59.999Z");
  const [runsA, runsB] = await Promise.all([
    engineA.tick(firstObservation),
    engineB.tick(secondObservation),
  ]);
  const runs = [...runsA, ...runsB];

  assert.equal(runs.length, 1);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(runs[0]?.input, { scheduledAt: "2026-08-27T12:05:00.000Z" });
  assert.match(runs[0]?.idempotencyKey ?? "", /^schedule:[0-9a-f]{64}$/);
  assert.equal(dispatched[0]?.idempotencyKey, runs[0]?.idempotencyKey);

  const restarted = createWorkflowEngine({
    dispatcher,
    store,
    createId: deterministicIds("restarted"),
  });
  assert.deepEqual(await restarted.tick(new Date("2026-08-27T12:05:30.000Z")), []);
  assert.equal(dispatched.length, 1);

  const nextMinute = await restarted.tick(new Date("2026-08-27T12:06:20.000Z"));
  assert.equal(nextMinute.length, 1);
  assert.notEqual(nextMinute[0]?.idempotencyKey, runs[0]?.idempotencyKey);
  assert.deepEqual(nextMinute[0]?.input, { scheduledAt: "2026-08-27T12:06:00.000Z" });
});

test("keeps a schedule claim after dispatch failure so retry cannot duplicate the occurrence", async () => {
  const store = createInMemoryWorkflowEngineStore();
  let failingDispatches = 0;
  const failingDispatcher: WorkflowRunDispatcher = {
    async dispatch() {
      failingDispatches += 1;
      throw new Error("transport unavailable");
    },
  };

  const engine = createWorkflowEngine({
    dispatcher: failingDispatcher,
    store,
    createId: deterministicIds("failing"),
  });
  engine.registerWorkflow({ workflowId: "retry-safe", workflow });
  engine.registerTrigger({
    id: "retry-safe-trigger",
    type: "cron",
    workflowId: "retry-safe",
    cron: "* * * * *",
  });

  const scheduledMinute = new Date("2026-08-27T12:05:45.000Z");
  const firstRuns = await engine.tick(scheduledMinute);
  assert.equal(firstRuns.length, 1);
  assert.equal(firstRuns[0]?.status, "interrupted");
  assert.equal(firstRuns[0]?.recoveryDisposition, "manual");
  assert.equal(failingDispatches, 1);

  let retryDispatches = 0;
  const restarted = createWorkflowEngine({
    dispatcher: {
      async dispatch(request) {
        retryDispatches += 1;
        return { status: "succeeded", output: request.input ?? {} };
      },
    },
    store,
    createId: deterministicIds("retry"),
  });

  assert.deepEqual(await restarted.tick(new Date("2026-08-27T12:05:50.000Z")), []);
  assert.equal(retryDispatches, 0);
});


test("derives the same schedule idempotency key without shared process state", async () => {
  const scheduledKey = async (prefix: string, observedAt: string) => {
    const store = createInMemoryWorkflowEngineStore();
    const engine = createWorkflowEngine({
      dispatcher: createDispatcher(),
      store,
      createId: deterministicIds(prefix),
    });
    engine.registerWorkflow({ workflowId: "deterministic-key", workflow });
    engine.registerTrigger({
      id: "stable-trigger-id",
      type: "cron",
      workflowId: "deterministic-key",
      cron: "* * * * *",
    });

    const runs = await engine.tick(new Date(observedAt));
    assert.equal(runs.length, 1);
    return runs[0]?.idempotencyKey;
  };

  const first = await scheduledKey("process-a", "2026-08-27T12:05:01.000Z");
  const second = await scheduledKey("process-b", "2026-08-27T12:05:59.999Z");

  assert.equal(first, second);
});


test("recovers a proven not-dispatched run with the same run identity", async () => {
  const store = createInMemoryWorkflowEngineStore();
  let initialDispatches = 0;
  const firstEngine = createWorkflowEngine({
    store,
    createId: deterministicIds("recoverable"),
    dispatcher: {
      async dispatch() {
        initialDispatches += 1;
        throw new WorkflowDispatchError("queue unavailable", "not-dispatched");
      },
    },
  });
  firstEngine.registerWorkflow({ workflowId: "evaluation", workflow });

  const interrupted = await firstEngine.startRun({
    workflowId: "evaluation",
    idempotencyKey: "evaluation:source-1",
    input: { sourceId: "source-1" },
  });

  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recoveryDisposition, "retryable");
  assert.equal(interrupted.failureKind, "dispatch");
  assert.equal(interrupted.dispatchAttempts, 1);
  assert.equal(initialDispatches, 1);

  const delivered: WorkflowRunDispatchRequest[] = [];
  const restarted = createWorkflowEngine({
    store,
    createId: deterministicIds("unused"),
    dispatcher: {
      async dispatch(request) {
        delivered.push(structuredClone(request));
        return { status: "succeeded", output: { judgmentId: "judgment:1" } };
      },
    },
  });

  const recovery = await restarted.recoverRuns();
  assert.equal(recovery.ambiguous.length, 0);
  assert.equal(recovery.recovered.length, 1);
  const recovered = recovery.recovered[0];
  assert.equal(recovered?.id, interrupted.id);
  assert.equal(recovered?.idempotencyKey, interrupted.idempotencyKey);
  assert.equal(recovered?.dispatchAttempts, 2);
  assert.equal(recovered?.status, "succeeded");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.runId, interrupted.id);
  assert.equal(delivered[0]?.idempotencyKey, interrupted.idempotencyKey);

  assert.deepEqual(await restarted.recoverRuns(), { recovered: [], ambiguous: [] });
});

test("does not redispatch an ambiguous interrupted run", async () => {
  const store = createInMemoryWorkflowEngineStore();
  const engine = createWorkflowEngine({
    store,
    createId: deterministicIds("ambiguous"),
    dispatcher: {
      async dispatch() {
        throw new Error("connection dropped after delivery");
      },
    },
  });
  engine.registerWorkflow({ workflowId: "evaluation", workflow });

  const interrupted = await engine.startRun({
    workflowId: "evaluation",
    input: { sourceId: "source-1" },
  });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recoveryDisposition, "manual");

  let redispatches = 0;
  const restarted = createWorkflowEngine({
    store,
    dispatcher: {
      async dispatch() {
        redispatches += 1;
        return { status: "succeeded", output: {} };
      },
    },
  });
  const recovery = await restarted.recoverRuns();

  assert.equal(recovery.recovered.length, 0);
  assert.equal(recovery.ambiguous.length, 1);
  assert.equal(recovery.ambiguous[0]?.id, interrupted.id);
  assert.equal(redispatches, 0);
});

test("reuses an existing run for the same explicit idempotency key", async () => {
  let dispatches = 0;
  const engine = createWorkflowEngine({
    dispatcher: {
      async dispatch(request) {
        dispatches += 1;
        return { status: "succeeded", output: request.input ?? {} };
      },
    },
    createId: deterministicIds("idempotent"),
  });
  engine.registerWorkflow({ workflowId: "evaluation", workflow });

  const first = await engine.startRun({
    workflowId: "evaluation",
    idempotencyKey: "evaluation:stable",
    input: { sourceId: "source-1" },
  });
  const duplicate = await engine.startRun({
    workflowId: "evaluation",
    idempotencyKey: "evaluation:stable",
    input: { sourceId: "source-1" },
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(dispatches, 1);

  await assert.rejects(
    engine.startRun({
      workflowId: "evaluation",
      idempotencyKey: "evaluation:stable",
      input: { sourceId: "different-source" },
    }),
    WorkflowRunIdempotencyConflictError,
  );
});

test("workflow execution failures are terminal and are not recovered", async () => {
  const store = createInMemoryWorkflowEngineStore();
  const engine = createWorkflowEngine({
    store,
    createId: deterministicIds("workflow-failure"),
    dispatcher: {
      async dispatch() {
        return { status: "failed", error: { code: "MODEL_REJECTED" } };
      },
    },
  });
  engine.registerWorkflow({ workflowId: "evaluation", workflow });
  const failed = await engine.startRun({ workflowId: "evaluation" });

  assert.equal(failed.status, "failed");
  assert.equal(failed.failureKind, "workflow");
  assert.deepEqual(await engine.recoverRuns(), { recovered: [], ambiguous: [] });
});


test("reconciles a concurrent start that already claimed the same idempotency key", async () => {
  const underlying = createInMemoryWorkflowEngineStore();
  let injectConflict = true;
  const store = {
    ...underlying,
    saveRun(run: Parameters<typeof underlying.saveRun>[0]) {
      if (injectConflict && run.status === "queued") {
        injectConflict = false;
        underlying.saveRun({ ...run, id: "winning-run" });
        throw new WorkflowRunIdempotencyConflictError(run.idempotencyKey);
      }
      return underlying.saveRun(run);
    },
  };

  let dispatches = 0;
  const engine = createWorkflowEngine({
    store,
    createId: deterministicIds("losing-run"),
    dispatcher: {
      async dispatch() {
        dispatches += 1;
        return { status: "succeeded", output: {} };
      },
    },
  });
  engine.registerWorkflow({ workflowId: "evaluation", workflow });

  const run = await engine.startRun({
    workflowId: "evaluation",
    idempotencyKey: "evaluation:concurrent",
    input: { sourceId: "source-1" },
  });

  assert.equal(run.id, "winning-run");
  assert.equal(run.status, "queued");
  assert.equal(dispatches, 0);
  assert.equal(engine.listRuns().length, 1);
});


test("concurrent recovery claims a queued run for dispatch only once", async () => {
  const store = createInMemoryWorkflowEngineStore();
  const setup = createWorkflowEngine({
    store,
    dispatcher: createDispatcher(),
  });
  const definition = setup.registerWorkflow({ workflowId: "recover-once", workflow });
  store.saveRun({
    id: "queued-recovery",
    workflowId: definition.workflowId,
    workflowVersion: definition.version,
    workflowDigest: definition.digest,
    idempotencyKey: "recovery:once",
    status: "queued",
    dispatchAttempts: 0,
    input: { sourceId: "source-1" },
    context: {},
    createdAt: "2026-09-24T03:00:00.000Z",
  });

  let releaseDispatch: (() => void) | undefined;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let dispatches = 0;
  const dispatcher: WorkflowRunDispatcher = {
    async dispatch() {
      dispatches += 1;
      await dispatchGate;
      return { status: "succeeded", output: { ok: true } };
    },
  };
  const engineA = createWorkflowEngine({ store, dispatcher });
  const engineB = createWorkflowEngine({ store, dispatcher });

  const recoveryA = engineA.recoverRuns();
  await Promise.resolve();
  const recoveryB = engineB.recoverRuns();
  await Promise.resolve();

  assert.equal(dispatches, 1);
  releaseDispatch?.();

  const [resultA, resultB] = await Promise.all([recoveryA, recoveryB]);
  assert.equal(resultA.recovered.length + resultB.recovered.length, 1);
  assert.equal(store.getRun("queued-recovery")?.status, "succeeded");
});
