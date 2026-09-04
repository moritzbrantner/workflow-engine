import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowEngine,
  matchesCron,
  type ExecutableWorkflow,
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

function deterministicIds() {
  let next = 1;
  return () => `id-${next++}`;
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
