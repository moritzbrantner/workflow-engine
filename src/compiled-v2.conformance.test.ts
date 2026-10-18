import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileWorkflowEngineStore,
  createWorkflowEngine,
  InvalidExecutableWorkflowError,
  validateExecutableWorkflow,
  type ExecutableWorkflow,
  type WorkflowRunDispatchRequest,
  type WorkflowRunDispatcher,
} from "./index";

/** Copied unchanged from workflow-editor fixtures/compiled-v2-bounded-iteration.json. */
const compiledV2Fixture = JSON.parse(
  readFileSync(new URL("../fixtures/compiled-v2-bounded-iteration.json", import.meta.url), "utf8"),
) as ExecutableWorkflow;

function recordingDispatcher() {
  const requests: WorkflowRunDispatchRequest[] = [];
  const dispatcher: WorkflowRunDispatcher = {
    async dispatch(request) {
      requests.push(structuredClone(request));
      return { status: "succeeded", output: { status: "converged", value: Math.SQRT2 } };
    },
  };
  return { dispatcher, requests };
}

function ids(prefix: string) {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

function withIteration(mutate: (iteration: Record<string, any>) => void): unknown {
  const workflow = structuredClone(compiledV2Fixture) as unknown as {
    nodes: Array<Record<string, any>>;
  };
  const node = workflow.nodes.find((candidate) => candidate.kind === "control.iterate")!;
  mutate(node.iteration);
  return workflow;
}

test("registers, stores and dispatches the editor compiled-v2 fixture unchanged across restart", async () => {
  assert.equal(compiledV2Fixture.version, 2);
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-v2-"));
  try {
    const filePath = join(directory, "engine.json");
    const host = recordingDispatcher();
    const engine = createWorkflowEngine({
      dispatcher: host.dispatcher,
      store: createFileWorkflowEngineStore(filePath),
      createId: ids("first"),
    });
    const first = engine.registerWorkflow({ workflowId: "sqrt", workflow: compiledV2Fixture });
    const duplicate = engine.registerWorkflow({
      workflowId: "sqrt",
      workflow: structuredClone(compiledV2Fixture),
    });
    assert.equal(first.version, 1);
    assert.equal(duplicate.version, 1);
    assert.equal(duplicate.digest, first.digest);

    const changed = engine.registerWorkflow({
      workflowId: "sqrt",
      workflow: withIteration((iteration) => {
        iteration.maxIterations = 11;
      }) as ExecutableWorkflow,
    });
    assert.equal(changed.version, 2);
    assert.notEqual(changed.digest, first.digest);

    const restarted = createWorkflowEngine({
      dispatcher: host.dispatcher,
      store: createFileWorkflowEngineStore(filePath),
      createId: ids("restarted"),
    });
    const stored = restarted.listWorkflowVersions("sqrt");
    assert.deepEqual(stored[0]?.workflow, compiledV2Fixture);

    const run = await restarted.startRun({
      workflowId: "sqrt",
      workflowVersion: 1,
      input: { state: 1, target: 2 },
    });
    assert.equal(run.status, "succeeded");
    assert.equal(run.workflowDigest, first.digest);
    assert.deepEqual(host.requests[0]?.workflow, compiledV2Fixture);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects malformed or unbounded iterations before dispatch", () => {
  const cases: Array<[string, unknown, string]> = [
    [
      "missing bound",
      withIteration((iteration) => {
        delete iteration.maxIterations;
      }),
      "/nodes/2/iteration/maxIterations",
    ],
    [
      "non-finite bound",
      withIteration((iteration) => {
        iteration.maxIterations = 0;
      }),
      "/nodes/2/iteration/maxIterations",
    ],
    [
      "missing next boundary",
      withIteration((iteration) => {
        delete iteration.body.outputs.next;
      }),
      "/nodes/2/iteration/body/outputs/next",
    ],
    [
      "boundary to unknown body port",
      withIteration((iteration) => {
        iteration.body.inputs[0].portId = "missing";
      }),
      "/nodes/2/iteration/body/inputs/0",
    ],
    [
      "invalid body graph",
      withIteration((iteration) => {
        iteration.body.order = ["newton-step"];
      }),
      "/nodes/2/iteration/body/order",
    ],
  ];

  for (const [name, workflow, path] of cases) {
    const result = validateExecutableWorkflow(workflow);
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.ok(
        result.diagnostics.some((diagnostic) => diagnostic.path === path),
        `${name}: ${JSON.stringify(result.diagnostics)}`,
      );
    }
  }

  const nested = withIteration((iteration) => {
    iteration.body.nodes[0].kind = "control.iterate";
    iteration.body.nodes[0].iteration = structuredClone(iteration);
  });
  const nestedResult = validateExecutableWorkflow(nested);
  assert.equal(
    !nestedResult.ok && nestedResult.diagnostics[0]?.code,
    "nested-iteration-not-supported",
  );

  const v1WithIteration = { ...(structuredClone(compiledV2Fixture) as object), version: 1 };
  const v1Result = validateExecutableWorkflow(v1WithIteration);
  assert.equal(!v1Result.ok && v1Result.diagnostics[0]?.code, "invalid-iteration");

  const host = recordingDispatcher();
  const engine = createWorkflowEngine({ dispatcher: host.dispatcher, createId: ids("invalid") });
  assert.throws(
    () =>
      engine.registerWorkflow({ workflowId: "bad", workflow: cases[0]![1] as ExecutableWorkflow }),
    InvalidExecutableWorkflowError,
  );
  assert.equal(host.requests.length, 0);
});
