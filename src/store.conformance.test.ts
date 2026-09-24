import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileWorkflowEngineStore,
  createInMemoryWorkflowEngineStore,
  digestExecutableWorkflow,
  InvalidWorkflowRunTransitionError,
  WorkflowDefinitionVersionConflictError,
  WorkflowRunIdempotencyConflictError,
  type ExecutableWorkflow,
  type WorkflowEngineStore,
  type WorkflowRunRecord,
} from "./index";

const workflow: ExecutableWorkflow = {
  format: "@moritzbrantner/workflow/compiled",
  version: 1,
  nodes: [{ id: "node", kind: "control.start", outputs: [{ id: "out" }] }],
  edges: [],
  order: ["node"],
};

type StoreFixture = {
  store: WorkflowEngineStore;
  reopen(): WorkflowEngineStore;
  cleanup(): void;
};

type StoreFactory = () => StoreFixture;

function defineStoreConformance(name: string, factory: StoreFactory): void {
  test(`${name}: definitions, triggers, claims, and runs obey the store contract`, () => {
    const fixture = factory();
    try {
      const digest = digestExecutableWorkflow(workflow);
      const definition = {
        workflowId: "conformance",
        version: 1,
        digest,
        workflow,
        createdAt: "2026-09-24T01:00:00.000Z",
      };
      const saved = fixture.store.saveDefinition(definition);
      assert.deepEqual(saved, definition);
      assert.deepEqual(fixture.store.saveDefinition(structuredClone(definition)), definition);

      assert.throws(
        () =>
          fixture.store.saveDefinition({
            ...definition,
            digest: "different",
          }),
        WorkflowDefinitionVersionConflictError,
      );

      fixture.store.saveTrigger({
        id: "trigger",
        type: "cron",
        workflowId: "conformance",
        workflowVersion: 1,
        enabled: true,
        cron: "* * * * *",
      });
      assert.equal(fixture.store.getTrigger("trigger")?.id, "trigger");

      const claim = {
        triggerId: "trigger",
        scheduledAt: "2026-09-24T01:05:00.000Z",
        idempotencyKey: "schedule:key",
      };
      assert.equal(fixture.store.claimSchedule(claim), true);
      assert.equal(fixture.store.claimSchedule(claim), false);

      const scheduledClaim = {
        triggerId: "trigger",
        scheduledAt: "2026-09-24T01:06:00.000Z",
        idempotencyKey: "schedule:run",
      };
      const scheduledRun: WorkflowRunRecord = {
        id: "scheduled-run",
        workflowId: "conformance",
        workflowVersion: 1,
        workflowDigest: digest,
        triggerId: "trigger",
        idempotencyKey: scheduledClaim.idempotencyKey,
        status: "queued",
        dispatchAttempts: 0,
        input: { scheduledAt: scheduledClaim.scheduledAt },
        context: {},
        createdAt: "2026-09-24T01:06:00.000Z",
      };
      assert.equal(fixture.store.claimScheduleRun(scheduledClaim, scheduledRun), true);
      assert.equal(fixture.store.claimScheduleRun(scheduledClaim, scheduledRun), false);
      assert.equal(fixture.store.getRun("scheduled-run")?.status, "queued");

      const queued: WorkflowRunRecord = {
        id: "run",
        workflowId: "conformance",
        workflowVersion: 1,
        workflowDigest: digest,
        triggerId: "trigger",
        idempotencyKey: "run:key",
        status: "queued",
        dispatchAttempts: 0,
        input: { value: 1 },
        context: { tenant: "test" },
        createdAt: "2026-09-24T01:05:00.000Z",
      };
      fixture.store.saveRun(queued);
      const running = fixture.store.claimRunForDispatch(
        queued.id,
        "2026-09-24T01:05:01.000Z",
      );
      assert.equal(running?.status, "running");
      assert.equal(running?.dispatchAttempts, 1);
      assert.ok(running);
      const succeeded: WorkflowRunRecord = {
        ...running,
        status: "succeeded",
        output: { ok: true },
        finishedAt: "2026-09-24T01:05:02.000Z",
      };
      fixture.store.saveRun(succeeded);

      assert.equal(fixture.store.getRun("run")?.status, "succeeded");
      assert.equal(fixture.store.getRunByIdempotencyKey("run:key")?.id, "run");
      assert.throws(
        () => fixture.store.saveRun({ ...queued, id: "other-run" }),
        WorkflowRunIdempotencyConflictError,
      );
      assert.throws(
        () => fixture.store.saveRun({ ...succeeded, status: "running" }),
        InvalidWorkflowRunTransitionError,
      );

      const reopened = fixture.reopen();
      assert.equal(reopened.listDefinitions("conformance").length, 1);
      assert.equal(reopened.getTrigger("trigger")?.id, "trigger");
      assert.equal(reopened.claimSchedule(claim), false);
      assert.equal(reopened.getRun("run")?.status, "succeeded");
    } finally {
      fixture.cleanup();
    }
  });
}

defineStoreConformance("in-memory store", () => {
  const store = createInMemoryWorkflowEngineStore();
  return {
    store,
    reopen: () => store,
    cleanup: () => undefined,
  };
});

defineStoreConformance("file store", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-conformance-"));
  const filePath = join(directory, "state.json");
  return {
    store: createFileWorkflowEngineStore(filePath),
    reopen: () => createFileWorkflowEngineStore(filePath),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
});
