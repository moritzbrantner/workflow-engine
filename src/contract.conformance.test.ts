import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createWorkflowEngine,
  digestExecutableWorkflow,
  type ExecutableWorkflow,
  type WorkflowRunDispatcher,
} from "./index";

const compiledV1Fixture = JSON.parse(
  readFileSync(new URL("../fixtures/compiled-v1-simple.json", import.meta.url), "utf8"),
) as ExecutableWorkflow;

function deterministicIds() {
  let next = 1;
  return () => `conformance-${next++}`;
}

test("versions and dispatches the canonical editor compiled-v1 fixture unchanged", async () => {
  let dispatchedWorkflow: ExecutableWorkflow | undefined;
  const dispatcher: WorkflowRunDispatcher = {
    async dispatch(request) {
      dispatchedWorkflow = request.workflow;
      return { status: "succeeded", output: request.input ?? {} };
    },
  };
  const engine = createWorkflowEngine({ dispatcher, createId: deterministicIds() });

  const first = engine.registerWorkflow({ workflowId: "compiled-v1", workflow: compiledV1Fixture });
  const duplicate = engine.registerWorkflow({
    workflowId: "compiled-v1",
    workflow: structuredClone(compiledV1Fixture),
  });

  assert.equal(first.version, 1);
  assert.equal(duplicate.version, 1);
  assert.equal(
    digestExecutableWorkflow(compiledV1Fixture),
    "d0673dd7402edef1878fef5dbba3d37415fb1a59816d863168c2e76f20c5a829",
  );

  const run = await engine.startRun({
    workflowId: "compiled-v1",
    input: { message: "hello" },
  });

  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.output, { message: "hello" });
  assert.deepEqual(dispatchedWorkflow, compiledV1Fixture);
});
