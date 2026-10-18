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
  type WorkflowRunDispatchRequest,
  type WorkflowRunDispatchResult,
  type WorkflowRunDispatcher,
} from "./index";

const workflow: ExecutableWorkflow = {
  format: "@moritzbrantner/workflow/compiled",
  version: 1,
  nodes: [{ id: "job", kind: "custom.long-job" }],
  edges: [],
  order: ["job"],
};

/** A dispatcher whose runs stay unresolved until the test settles them. */
function deferredDispatcher() {
  const pending = new Map<string, (result: WorkflowRunDispatchResult) => void>();
  const requests: WorkflowRunDispatchRequest[] = [];
  const dispatcher: WorkflowRunDispatcher = {
    dispatch(request) {
      requests.push(structuredClone(request));
      return new Promise((resolve) => pending.set(request.runId, resolve));
    },
  };
  return {
    dispatcher,
    requests,
    activeRunIds: () => [...pending.keys()],
    settle(runId: string, output: unknown) {
      const resolve = pending.get(runId);
      assert.ok(resolve, `run ${runId} is not active`);
      pending.delete(runId);
      resolve({ status: "succeeded", output });
    },
  };
}

function ids(prefix: string) {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

async function provesOverlap(createStore: () => WorkflowEngineStore) {
  const store = createStore();
  const host = deferredDispatcher();
  const engineA = createWorkflowEngine({
    dispatcher: host.dispatcher,
    store,
    createId: ids("a"),
  });
  const registered = engineA.registerWorkflow({ workflowId: "long-job", workflow });
  engineA.registerTrigger({
    id: "every-minute",
    type: "cron",
    workflowId: "long-job",
    cron: "* * * * *",
  });
  const engineB = createWorkflowEngine({
    dispatcher: host.dispatcher,
    store: createStore(),
    createId: ids("b"),
  });

  // The host keeps ticking without awaiting earlier dispatches (TECH-002).
  const firstTick = engineA.tick(new Date("2026-10-18T09:00:05.000Z"));
  const secondTick = engineB.tick(new Date("2026-10-18T09:01:05.000Z"));

  // Both occurrences are active at the same time; the first is still unresolved.
  assert.equal(host.requests.length, 2);
  const [first, second] = host.requests;
  assert.deepEqual(host.activeRunIds(), [first!.runId, second!.runId]);
  assert.notEqual(first!.runId, second!.runId);
  assert.notEqual(first!.idempotencyKey, second!.idempotencyKey);
  assert.deepEqual(first!.input, { scheduledAt: "2026-10-18T09:00:00.000Z" });
  assert.deepEqual(second!.input, { scheduledAt: "2026-10-18T09:01:00.000Z" });
  assert.deepEqual(
    engineA
      .listRuns()
      .map((run) => run.status)
      .sort(),
    ["running", "running"],
  );

  // Re-observing either minute, on either instance, dispatches nothing new.
  assert.deepEqual(await engineB.tick(new Date("2026-10-18T09:00:59.000Z")), []);
  assert.deepEqual(await engineA.tick(new Date("2026-10-18T09:01:30.000Z")), []);
  assert.equal(host.requests.length, 2);

  // They complete independently, second first.
  host.settle(second!.runId, "second");
  const [secondRun] = await secondTick;
  assert.equal(secondRun?.status, "succeeded");
  assert.equal(engineA.getRun(first!.runId)?.status, "running");
  host.settle(first!.runId, "first");
  const [firstRun] = await firstTick;
  assert.equal(firstRun?.status, "succeeded");

  for (const run of [firstRun!, secondRun!]) {
    assert.equal(run.workflowVersion, registered.version);
    assert.equal(run.workflowDigest, registered.digest);
  }
  assert.deepEqual(
    [firstRun!.output, secondRun!.output, firstRun!.idempotencyKey, secondRun!.idempotencyKey],
    ["first", "second", first!.idempotencyKey, second!.idempotencyKey],
  );

  // A restarted engine on the same store does not redispatch either occurrence.
  const restarted = createWorkflowEngine({
    dispatcher: host.dispatcher,
    store: createStore(),
    createId: ids("restarted"),
  });
  assert.deepEqual(await restarted.tick(new Date("2026-10-18T09:00:10.000Z")), []);
  assert.deepEqual(await restarted.tick(new Date("2026-10-18T09:01:10.000Z")), []);
  assert.equal(host.requests.length, 2);
}

test("overlapping cron occurrences run independently with the in-memory store", async () => {
  const store = createInMemoryWorkflowEngineStore();
  await provesOverlap(() => store);
});

test("overlapping cron occurrences run independently across file-store instances", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-overlap-"));
  try {
    const filePath = join(directory, "engine.json");
    await provesOverlap(() => createFileWorkflowEngineStore(filePath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
