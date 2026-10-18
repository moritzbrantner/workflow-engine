import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileWorkflowEngineStore,
  createInMemoryWorkflowEngineStore,
  createWorkflowEngine,
  type ExecutableWorkflow,
  type WorkflowEngineStore,
  type WorkflowLiveRunStatus,
  type WorkflowRunDispatchObserver,
  type WorkflowRunDispatchResult,
  type WorkflowRunDispatcher,
} from "./index";

const workflow: ExecutableWorkflow = {
  format: "@moritzbrantner/workflow/compiled",
  version: 1,
  nodes: [
    { id: "render", kind: "asset.operation", outputs: [{ id: "asset" }] },
    { id: "publish", kind: "custom.publish", inputs: [{ id: "asset" }] },
  ],
  edges: [
    {
      id: "render-publish",
      sourceNodeId: "render",
      sourcePortId: "asset",
      targetNodeId: "publish",
      targetPortId: "asset",
    },
  ],
  order: ["render", "publish"],
};

/** A host dispatcher that reports live events and stays unresolved until the test finishes it. */
function liveDispatcher() {
  let observer: WorkflowRunDispatchObserver | undefined;
  let finish: ((result: WorkflowRunDispatchResult) => void) | undefined;
  const dispatcher: WorkflowRunDispatcher = {
    dispatch(_request, nextObserver) {
      observer = nextObserver;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  return {
    dispatcher,
    emit(event: Record<string, unknown>) {
      assert.ok(observer, "engine passes a live observer");
      observer.onEvent({ ...event, timestamp: "2026-10-18T10:00:00.000Z" } as never);
    },
    finish(result: WorkflowRunDispatchResult) {
      finish?.(result);
    },
  };
}

async function liveJourney(store: WorkflowEngineStore) {
  const host = liveDispatcher();
  const engine = createWorkflowEngine({ dispatcher: host.dispatcher, store });
  const definition = engine.registerWorkflow({ workflowId: "render", workflow });
  const seen: WorkflowLiveRunStatus[] = [];

  const pending = engine.startRun({ workflowId: "render", input: {} });
  const runId = engine.listRuns()[0]!.id;
  engine.observeRun(runId, (status) => seen.push(status));
  engine.observeRun(runId, () => {
    throw new Error("observer bug");
  });

  host.emit({ type: "run.started", runId });
  host.emit({ type: "node.started", runId, nodeId: "render", attempt: 1 });
  const running = engine.getLiveRun(runId);
  assert.equal(running?.status, "running");
  assert.equal(running?.workflowVersion, definition.version);
  assert.deepEqual(running?.nodes.render, {
    state: "running",
    attempt: 1,
    updatedAt: "2026-10-18T10:00:00.000Z",
  });
  assert.equal(engine.getRun(runId)?.status, "running");

  host.emit({ type: "node.succeeded", runId, nodeId: "render", attempt: 1, outputs: { asset: 1 } });
  host.emit({ type: "node.started", runId, nodeId: "publish", attempt: 1 });
  assert.equal(engine.getLiveRun(runId)?.nodes.render?.state, "succeeded");
  assert.equal(engine.getLiveRun(runId)?.nodes.publish?.state, "running");

  host.finish({ status: "succeeded", output: { published: true } });
  const record = await pending;

  assert.equal(record.status, "succeeded");
  assert.equal(seen.at(-1)?.status, "succeeded");
  assert.equal(seen.at(-1)?.runId, record.id);
  assert.equal(engine.getLiveRun(runId), undefined);
  // Live payloads (outputs) are not retained.
  assert.ok(!JSON.stringify(seen).includes("outputs"));
}

test("exposes live node progress while an in-memory dispatch is unresolved", async () => {
  await liveJourney(createInMemoryWorkflowEngineStore());
});

test("exposes live progress with the file store and keeps only persisted state after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-live-"));
  try {
    const filePath = join(directory, "engine.json");
    await liveJourney(createFileWorkflowEngineStore(filePath));

    const host = liveDispatcher();
    const engine = createWorkflowEngine({
      dispatcher: host.dispatcher,
      store: createFileWorkflowEngineStore(filePath),
    });
    const second = engine.startRun({ workflowId: "render", input: { second: true } });
    const runId = engine.listRuns().find((run) => run.status === "running")!.id;
    host.emit({ type: "node.started", runId, nodeId: "render", attempt: 1 });
    assert.equal(engine.getLiveRun(runId)?.nodes.render?.state, "running");

    // A restarted engine sees the durable record only, never stale live state.
    const restarted = createWorkflowEngine({
      dispatcher: host.dispatcher,
      store: createFileWorkflowEngineStore(filePath),
    });
    assert.equal(restarted.getLiveRun(runId), undefined);
    assert.equal(restarted.getRun(runId)?.status, "running");
    host.finish({ status: "succeeded", output: {} });
    assert.equal((await second).status, "succeeded");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dispatchers that report no live events keep working", async () => {
  const engine = createWorkflowEngine({
    dispatcher: { dispatch: async () => ({ status: "succeeded", output: 1 }) },
  });
  engine.registerWorkflow({ workflowId: "plain", workflow });
  const record = await engine.startRun({ workflowId: "plain" });
  assert.equal(record.status, "succeeded");
  assert.equal(engine.getLiveRun(record.id), undefined);
});
