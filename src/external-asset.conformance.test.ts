import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createWorkflowEngine,
  type ExecutableWorkflow,
  type WorkflowRunDispatchRequest,
} from "./index.js";

const compiled = JSON.parse(
  readFileSync(new URL("../fixtures/compiled-v1-external-asset.json", import.meta.url), "utf8"),
) as ExecutableWorkflow;

const outputAsset = {
  schemaVersion: 1,
  kind: "image",
  mediaType: "image/png",
  sha256: "b".repeat(64),
  byteLength: 128,
  metadata: { width: 64, height: 64 },
};

test("pins an external-operation workflow version and stores JSON-safe asset references exactly once", async () => {
  let dispatches = 0;
  let submitted: WorkflowRunDispatchRequest | undefined;
  const engine = createWorkflowEngine({
    createId: () => "external-run-1",
    now: () => new Date("2026-10-16T18:00:00.000Z"),
    dispatcher: {
      async dispatch(request) {
        dispatches += 1;
        submitted = structuredClone(request);
        return { status: "succeeded", output: outputAsset };
      },
    },
  });

  const before = structuredClone(compiled);
  const registered = engine.registerWorkflow({ workflowId: "external-asset", workflow: compiled });
  const input = { requestId: "icon-1" };
  const first = await engine.startRun({
    workflowId: "external-asset",
    input,
    idempotencyKey: "asset:icon-1",
  });
  const again = await engine.startRun({
    workflowId: "external-asset",
    input,
    idempotencyKey: "asset:icon-1",
  });

  assert.equal(dispatches, 1);
  assert.deepEqual(again, first);
  assert.equal(first.status, "succeeded");
  assert.deepEqual(first.output, outputAsset);
  assert.equal(first.workflowVersion, registered.version);
  assert.equal(first.workflowDigest, registered.digest);
  assert.deepEqual(submitted?.workflow, compiled);
  assert.deepEqual(submitted?.input, input);
  assert.equal(submitted?.idempotencyKey, "asset:icon-1");
  assert.deepEqual(engine.getRun(first.id), first);
  assert.deepEqual(compiled, before);
  assert.equal(
    engine.registerWorkflow({ workflowId: "external-asset", workflow: compiled }).version,
    1,
  );

  const newNativeWorkflow = structuredClone(compiled);
  const node = newNativeWorkflow.nodes.find((node) => node.id === "generate");
  assert.ok(node);
  const operation = node.data?.assetOperation as { parameters: { workflow: { sha256: string } } };
  operation.parameters.workflow.sha256 = "c".repeat(64);
  const updated = engine.registerWorkflow({
    workflowId: "external-asset",
    workflow: newNativeWorkflow,
  });
  assert.equal(updated.version, 2);
  assert.notEqual(updated.digest, registered.digest);
  assert.equal(first.workflowDigest, registered.digest);
  assert.equal(first.workflowVersion, 1);
});

test("ambiguous external dispatch stays manual instead of resubmitting a model job", async () => {
  let dispatches = 0;
  const engine = createWorkflowEngine({
    createId: () => "external-interrupted",
    dispatcher: {
      async dispatch() {
        dispatches += 1;
        throw new Error("response lost after possible external job acceptance");
      },
    },
  });
  engine.registerWorkflow({ workflowId: "external-asset", workflow: compiled });

  const run = await engine.startRun({
    workflowId: "external-asset",
    idempotencyKey: "asset:uncertain",
  });
  assert.equal(run.status, "interrupted");
  assert.equal(run.recoveryDisposition, "manual");
  const recovery = await engine.recoverRuns();
  assert.equal(recovery.recovered.length, 0);
  assert.deepEqual(
    recovery.ambiguous.map((value) => value.id),
    [run.id],
  );
  assert.equal(dispatches, 1);
});
