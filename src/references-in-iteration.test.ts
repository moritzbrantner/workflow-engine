import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createWorkflowEngine,
  validateExecutableWorkflow,
  type ExecutableWorkflow,
  type WorkflowRunDispatchRequest,
} from "./index";

/** Copied unchanged from workflow-editor fixtures/compiled-v3-reference-in-iteration.json (#141). */
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/compiled-v3-reference-in-iteration.json", import.meta.url),
    "utf8",
  ),
) as ExecutableWorkflow;

function variant(mutate: (workflow: any) => void): unknown {
  const workflow = structuredClone(fixture);
  mutate(workflow);
  return workflow;
}

test("registers and dispatches a reference inside an iteration body unchanged", async () => {
  assert.equal(validateExecutableWorkflow(fixture).ok, true);
  const requests: WorkflowRunDispatchRequest[] = [];
  const engine = createWorkflowEngine({
    dispatcher: {
      async dispatch(request) {
        requests.push(structuredClone(request));
        return { status: "succeeded", output: 8 };
      },
    },
  });
  engine.registerWorkflow({ workflowId: "loop", workflow: fixture });
  const run = await engine.startRun({ workflowId: "loop", input: { n: 1 } });

  assert.equal(run.status, "succeeded");
  assert.deepEqual(requests[0]?.workflow, fixture);
});

test("validates body references against the root closure", () => {
  const codes = (workflow: unknown) => {
    const result = validateExecutableWorkflow(workflow);
    return result.ok
      ? []
      : result.diagnostics.map((diagnostic) => diagnostic.path + " " + diagnostic.code);
  };

  assert.ok(
    codes(
      variant((workflow) => {
        workflow.nodes[1].iteration.body.nodes[0].workflowRef.workflow = "missing@1";
      }),
    ).includes("/nodes/1/iteration/body/nodes/0/workflowRef/workflow invalid-workflow-reference"),
  );
  assert.ok(
    codes(
      variant((workflow) => {
        workflow.nodes[1].iteration.body.nodes[0].workflowRef.maxDepth = 0;
      }),
    ).some((entry) => entry.endsWith("invalid-workflow-reference")),
  );
  assert.ok(
    codes(
      variant((workflow) => {
        const child = workflow.workflows["child@1"];
        child.nodes.push({
          id: "inner-loop",
          kind: "control.iterate",
          inputs: [{ id: "state" }],
          outputs: [{ id: "result" }],
          iteration: structuredClone(workflow.nodes[1].iteration),
        });
        child.order.push("inner-loop");
      }),
    ).some((entry) => entry.endsWith("unbounded-recursive-reference")),
  );
  assert.ok(
    codes(
      variant((workflow) => {
        workflow.version = 2;
        delete workflow.workflows;
      }),
    ).some((entry) => entry.endsWith("invalid-workflow-reference")),
  );
});
