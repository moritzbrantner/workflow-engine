import assert from "node:assert/strict";
import test from "node:test";

import {
  createInMemoryWorkflowEngineStore,
  createWorkflowEngine,
  matchesCron,
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
  assert.equal(firstRuns[0]?.status, "failed");
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
