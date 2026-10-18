import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileWorkflowEngineStore,
  createInMemoryWorkflowEngineStore,
  createWorkflowEngine,
  WorkflowTaskNotPendingError,
  WorkflowTaskResponseInvalidError,
  type ExecutableWorkflow,
  type WorkflowEngineStore,
  type WorkflowHumanTaskResponseValidator,
  type WorkflowRunDispatchRequest,
  type WorkflowRunDispatcher,
} from "./index";

/** Copied unchanged from workflow-editor fixtures/compiled-v1-human-tasks.json (editor #105). */
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/compiled-v1-human-tasks.json", import.meta.url), "utf8"),
) as ExecutableWorkflow;

/**
 * Host dispatcher shaped like Workflow Runner (#30, #41): it suspends at human tasks with a
 * checkpoint and resumes from it, executing each side-effecting node at most once per run.
 */
function runnerShapedHost() {
  const requests: WorkflowRunDispatchRequest[] = [];
  const sideEffects: string[] = [];
  const dispatcher: WorkflowRunDispatcher = {
    async dispatch(request) {
      requests.push(structuredClone(request));
      const suspend = (nodeId: string, completed: string[]) => ({
        status: "suspended" as const,
        checkpoint: {
          format: "@moritzbrantner/workflow-runner/checkpoint",
          version: 1,
          runId: request.runId,
          waiting: { nodeId, taskId: nodeId, attempt: 1, request: { prompt: nodeId } },
          completed: Object.fromEntries(completed.map((id) => [id, { status: "succeeded" }])),
        },
      });
      if (!request.resume) {
        sideEffects.push(`expense:${request.runId}`);
        return suspend("review", ["expense"]);
      }
      const checkpoint = request.resume.checkpoint as { waiting: { nodeId: string } };
      const response = request.resume.response as { decision?: string; value?: unknown };
      if (checkpoint.waiting.nodeId === "review" && response.decision === "rejected") {
        return suspend("correct", ["expense", "review"]);
      }
      const effect =
        checkpoint.waiting.nodeId === "review" ? "pay" : `record:${String(response.value)}`;
      sideEffects.push(`${effect}:${request.runId}`);
      return { status: "succeeded" as const, output: { done: effect } };
    },
  };
  return { dispatcher, requests, sideEffects };
}

/** Stands in for workflow-editor's validateWorkflowEditorHumanTaskResponse type check. */
const numberValidator: WorkflowHumanTaskResponseValidator = (humanTask, response, options) => {
  assert.equal(options.typeDeclarations, fixture.typeDeclarations);
  const task = humanTask as { kind: string; responseType?: { source?: string } };
  const value = (response as { value?: unknown }).value;
  return task.kind === "input" &&
    task.responseType?.source === "number" &&
    typeof value !== "number"
    ? ["The response value does not match the requested type."]
    : [];
};

function engineOn(store: WorkflowEngineStore, host: ReturnType<typeof runnerShapedHost>) {
  return createWorkflowEngine({
    dispatcher: host.dispatcher,
    store,
    validateHumanTaskResponse: numberValidator,
  });
}

test("an approval wait survives a restart and resumes the same run once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-human-"));
  try {
    const filePath = join(directory, "engine.json");
    const host = runnerShapedHost();
    const engine = engineOn(createFileWorkflowEngineStore(filePath), host);
    const definition = engine.registerWorkflow({ workflowId: "expense", workflow: fixture });
    const waiting = await engine.startRun({ workflowId: "expense", input: { id: "exp-1" } });

    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.finishedAt, undefined);

    const restarted = engineOn(createFileWorkflowEngineStore(filePath), host);
    const [task] = restarted.listPendingTasks();
    assert.deepEqual(
      { ...task, since: undefined },
      {
        runId: waiting.id,
        workflowId: "expense",
        workflowVersion: definition.version,
        nodeId: "review",
        taskId: "review",
        humanTask: {
          kind: "approval",
          prompt: "Approve this expense?",
          outcomes: ["approved", "rejected"],
        },
        request: { prompt: "review" },
        since: undefined,
      },
    );

    await assert.rejects(
      restarted.respondToTask({
        runId: waiting.id,
        taskId: "review",
        response: { decision: "yes" },
      }),
      WorkflowTaskResponseInvalidError,
    );
    assert.equal(restarted.getRun(waiting.id)?.status, "waiting");

    const done = await restarted.respondToTask({
      runId: waiting.id,
      taskId: "review",
      response: { decision: "approved", comment: "fine" },
    });
    assert.equal(done.id, waiting.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.workflowDigest, definition.digest);
    assert.equal(done.idempotencyKey, waiting.idempotencyKey);
    assert.equal(done.waiting, undefined);
    assert.deepEqual(host.requests[1]?.resume?.response, { decision: "approved", comment: "fine" });
    assert.deepEqual(host.sideEffects, [`expense:${waiting.id}`, `pay:${waiting.id}`]);
    assert.deepEqual(restarted.listPendingTasks(), []);

    await assert.rejects(
      restarted.respondToTask({
        runId: waiting.id,
        taskId: "review",
        response: { decision: "approved" },
      }),
      WorkflowTaskNotPendingError,
    );
    assert.equal(host.requests.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent responses dispatch exactly one continuation", async () => {
  const host = runnerShapedHost();
  const store = createInMemoryWorkflowEngineStore();
  const engineA = engineOn(store, host);
  const engineB = engineOn(store, host);
  engineA.registerWorkflow({ workflowId: "expense", workflow: fixture });
  const waiting = await engineA.startRun({ workflowId: "expense" });

  const results = await Promise.allSettled([
    engineA.respondToTask({
      runId: waiting.id,
      taskId: "review",
      response: { decision: "approved" },
    }),
    engineB.respondToTask({
      runId: waiting.id,
      taskId: "review",
      response: { decision: "rejected" },
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" && rejected.reason instanceof WorkflowTaskNotPendingError,
  );
  assert.equal(host.requests.filter((request) => request.resume).length, 1);
});

test("a rejection leads to a typed input task that validates and continues", async () => {
  const host = runnerShapedHost();
  const engine = engineOn(createInMemoryWorkflowEngineStore(), host);
  engine.registerWorkflow({ workflowId: "expense", workflow: fixture });
  const waiting = await engine.startRun({ workflowId: "expense" });

  const correction = await engine.respondToTask({
    runId: waiting.id,
    taskId: "review",
    response: { decision: "rejected" },
  });
  assert.equal(correction.status, "waiting");
  assert.equal(correction.waiting?.taskId, "correct");
  assert.deepEqual(correction.waiting?.humanTask, {
    kind: "input",
    prompt: "Enter the corrected amount.",
    responseType: { kind: "typescript", source: "number" },
  });

  for (const response of [{}, { value: "80" }, { value: 80, comment: 3 }]) {
    await assert.rejects(
      engine.respondToTask({ runId: waiting.id, taskId: "correct", response }),
      WorkflowTaskResponseInvalidError,
    );
  }
  const done = await engine.respondToTask({
    runId: waiting.id,
    taskId: "correct",
    response: { value: 80 },
  });
  assert.equal(done.status, "succeeded");
  assert.deepEqual(host.sideEffects, [`expense:${waiting.id}`, `record:80:${waiting.id}`]);
});

test("a suspension without a waiting task is parked for manual recovery", async () => {
  const engine = createWorkflowEngine({
    dispatcher: { dispatch: async () => ({ status: "suspended", checkpoint: { waiting: {} } }) },
  });
  engine.registerWorkflow({ workflowId: "expense", workflow: fixture });
  const run = await engine.startRun({ workflowId: "expense" });

  assert.equal(run.status, "interrupted");
  assert.equal(run.recoveryDisposition, "manual");
  assert.deepEqual(engine.listPendingTasks(), []);
});
