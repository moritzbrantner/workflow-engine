import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createInMemoryWorkflowEngineStore,
  createWorkflowEngine,
  InvalidExecutableWorkflowError,
  validateExecutableWorkflow,
  type WorkflowRunDispatcher,
} from "./index";

const compiledV1Fixture = JSON.parse(
  readFileSync(new URL("../fixtures/compiled-v1-simple.json", import.meta.url), "utf8"),
) as unknown;

const dispatcher: WorkflowRunDispatcher = {
  async dispatch(request) {
    return { status: "succeeded", output: request.input ?? {} };
  },
};

test("accepts the canonical compiled-v1 fixture without stripping forward-compatible data", () => {
  const result = validateExecutableWorkflow(compiledV1Fixture);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.workflow, compiledV1Fixture);
  assert.deepEqual(
    (result.workflow.nodes[0]?.outputs?.[0] as Record<string, unknown> | undefined)?.type,
    { kind: "any" },
  );
});

test("returns stable structured diagnostics for malformed compiled-v1 graphs", () => {
  const malformed = {
    format: "@moritzbrantner/workflow/compiled",
    version: 1,
    nodes: [
      {
        id: "start",
        kind: "control.start",
        outputs: [{ id: "out" }, { id: "out" }],
      },
      { id: "start", kind: "task.duplicate" },
      { id: "end", kind: "control.end", inputs: [{ id: "in" }] },
    ],
    edges: [
      {
        id: "edge",
        sourceNodeId: "missing",
        sourcePortId: "out",
        targetNodeId: "end",
        targetPortId: "in",
      },
      {
        id: "edge",
        sourceNodeId: "start",
        sourcePortId: "missing",
        targetNodeId: "end",
        targetPortId: "missing",
      },
    ],
    order: ["start", "start", "ghost"],
  };

  assert.deepEqual(validateExecutableWorkflow(malformed), {
    ok: false,
    diagnostics: [
      {
        code: "duplicate-port-id",
        path: "/nodes/0/outputs/1/id",
        message: "Duplicate port id 'out' in the same port list.",
      },
      {
        code: "duplicate-node-id",
        path: "/nodes/1/id",
        message: "Duplicate workflow node id 'start'.",
      },
      {
        code: "duplicate-edge-id",
        path: "/edges/1/id",
        message: "Duplicate workflow edge id 'edge'.",
      },
      {
        code: "missing-edge-endpoint",
        path: "/edges/0/sourceNodeId",
        message: "Edge source node 'missing' does not exist.",
      },
      {
        code: "invalid-edge-port",
        path: "/edges/1/sourcePortId",
        message: "Source port 'missing' does not exist on node 'start'.",
      },
      {
        code: "invalid-edge-port",
        path: "/edges/1/targetPortId",
        message: "Target port 'missing' does not exist on node 'end'.",
      },
      {
        code: "duplicate-order-id",
        path: "/order/1",
        message: "Workflow order contains duplicate node id 'start'.",
      },
      {
        code: "unknown-order-id",
        path: "/order/2",
        message: "Workflow order references unknown node id 'ghost'.",
      },
      {
        code: "missing-order-id",
        path: "/order",
        message: "Workflow order is missing node id 'end'.",
      },
    ],
  });
});

test("does not interpret unsupported compiled versions as version 1", () => {
  const result = validateExecutableWorkflow({
    format: "@moritzbrantner/workflow/compiled",
    version: 2,
    nodes: "future-shape",
  });

  assert.deepEqual(result, {
    ok: false,
    diagnostics: [
      {
        code: "unsupported-version",
        path: "/version",
        message: "Unsupported compiled workflow version: 2.",
      },
    ],
  });
});

test("registerWorkflow rejects invalid workflows before persistence", () => {
  const store = createInMemoryWorkflowEngineStore();
  const engine = createWorkflowEngine({ dispatcher, store });

  assert.throws(
    () =>
      engine.registerWorkflow({
        workflowId: "invalid",
        workflow: {
          format: "@moritzbrantner/workflow/compiled",
          version: 1,
          nodes: [{ id: "start", kind: "control.start", outputs: [{ id: "out" }] }],
          edges: [
            {
              id: "edge",
              sourceNodeId: "start",
              sourcePortId: "missing",
              targetNodeId: "start",
              targetPortId: "missing",
            },
          ],
          order: ["start"],
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidExecutableWorkflowError);
      assert.equal(error.code, "INVALID_EXECUTABLE_WORKFLOW");
      assert.deepEqual(
        error.diagnostics.map(({ code, path }) => ({ code, path })),
        [
          { code: "invalid-edge-port", path: "/edges/0/sourcePortId" },
          { code: "invalid-edge-port", path: "/edges/0/targetPortId" },
        ],
      );
      return true;
    },
  );

  assert.deepEqual(engine.listWorkflowVersions("invalid"), []);
});
