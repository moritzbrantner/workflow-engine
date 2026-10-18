import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileWorkflowEngineStore,
  createWorkflowEngine,
  WorkflowDispatchError,
  type ExecutableWorkflow,
  type WorkflowRunDispatcher,
} from "./index";

const workflow: ExecutableWorkflow = {
  format: "@moritzbrantner/workflow/compiled",
  version: 1,
  nodes: [{ id: "render", kind: "asset.operation", outputs: [{ id: "asset" }] }],
  edges: [],
  order: ["render"],
};

/** The JSON-safe failed result Workflow Runner returns for a throwing executor (runner #25). */
const runnerFailure = {
  status: "failed" as const,
  error: {
    code: "node-failed",
    message: "Node render failed: render quota exceeded",
    nodeId: "render",
    attempt: 1,
    cause: { name: "Error", message: "render quota exceeded", code: "QUOTA_EXCEEDED" },
  },
  events: [
    { type: "run.started", runId: "r", maxWorkers: 4, timestamp: "2026-10-18T10:00:00.000Z" },
    {
      type: "node.failed",
      runId: "r",
      nodeId: "render",
      attempt: 1,
      timestamp: "2026-10-18T10:00:01.000Z",
      error: {
        code: "node-failed",
        message: "Node render failed: render quota exceeded",
        nodeId: "render",
        attempt: 1,
        cause: { name: "Error", message: "render quota exceeded", code: "QUOTA_EXCEEDED" },
      },
    },
  ],
};

test("a runner executor failure is stored as a workflow failure and survives reload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-runner-failure-"));
  try {
    const filePath = join(directory, "engine.json");
    let dispatches = 0;
    const dispatcher: WorkflowRunDispatcher = {
      async dispatch() {
        dispatches += 1;
        return structuredClone(runnerFailure);
      },
    };
    const engine = createWorkflowEngine({
      dispatcher,
      store: createFileWorkflowEngineStore(filePath),
    });
    engine.registerWorkflow({ workflowId: "render", workflow });
    const run = await engine.startRun({ workflowId: "render" });

    assert.equal(run.status, "failed");
    assert.equal(run.failureKind, "workflow");

    const reloaded = createWorkflowEngine({
      dispatcher,
      store: createFileWorkflowEngineStore(filePath),
    });
    const stored = reloaded.getRun(run.id);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.failureKind, "workflow");
    assert.deepEqual(stored?.error, runnerFailure.error);
    assert.deepEqual((await reloaded.recoverRuns()).recovered, []);
    assert.equal(dispatches, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unknown dispatch failure still stays a manual interruption without retry", async () => {
  let dispatches = 0;
  const engine = createWorkflowEngine({
    dispatcher: {
      async dispatch() {
        dispatches += 1;
        throw new WorkflowDispatchError("connection reset", "unknown");
      },
    },
  });
  engine.registerWorkflow({ workflowId: "render", workflow });
  const run = await engine.startRun({ workflowId: "render" });

  assert.equal(run.status, "interrupted");
  assert.equal(run.recoveryDisposition, "manual");
  await engine.recoverRuns();
  assert.equal(dispatches, 1);
});
