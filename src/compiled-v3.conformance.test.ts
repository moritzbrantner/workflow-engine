import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileWorkflowEngineStore,
  createWorkflowEngine,
  validateExecutableWorkflow,
  type ExecutableWorkflow,
  type WorkflowRunDispatchRequest,
} from "./index";

/** Copied unchanged from workflow-editor fixtures/compiled-v3-workflow-references.json. */
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/compiled-v3-workflow-references.json", import.meta.url),
    "utf8",
  ),
) as ExecutableWorkflow;

function variant(mutate: (workflow: any) => void): unknown {
  const workflow = structuredClone(fixture);
  mutate(workflow);
  return workflow;
}

test("registers, stores and dispatches the editor compiled-v3 fixture unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-engine-v3-"));
  try {
    const filePath = join(directory, "engine.json");
    const requests: WorkflowRunDispatchRequest[] = [];
    const dispatcher = {
      async dispatch(request: WorkflowRunDispatchRequest) {
        requests.push(structuredClone(request));
        return { status: "succeeded" as const, output: { result: 0 } };
      },
    };
    const engine = createWorkflowEngine({
      dispatcher,
      store: createFileWorkflowEngineStore(filePath),
    });
    const first = engine.registerWorkflow({ workflowId: "countdown", workflow: fixture });
    assert.equal(
      engine.registerWorkflow({ workflowId: "countdown", workflow: structuredClone(fixture) })
        .version,
      first.version,
    );

    const restarted = createWorkflowEngine({
      dispatcher,
      store: createFileWorkflowEngineStore(filePath),
    });
    assert.deepEqual(restarted.listWorkflowVersions("countdown")[0]?.workflow, fixture);
    const run = await restarted.startRun({ workflowId: "countdown", input: { n: 3 } });
    assert.equal(run.status, "succeeded");
    assert.deepEqual(requests[0]?.workflow, fixture);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects malformed reference closures before persistence", () => {
  const cases: Array<[unknown, string]> = [
    [
      variant((workflow) => {
        workflow.nodes[1].workflowRef.workflow = "missing@1";
      }),
      "invalid-workflow-reference",
    ],
    [
      variant((workflow) => {
        workflow.nodes[1].workflowRef.maxDepth = 0;
      }),
      "invalid-workflow-reference",
    ],
    [
      variant((workflow) => {
        delete workflow.nodes[1].workflowRef.maxDepth;
        delete workflow.workflows["countdown@1"].nodes[1].workflowRef.maxDepth;
      }),
      "unbounded-recursive-reference",
    ],
    [
      variant((workflow) => {
        workflow.workflows["countdown@1"].interface.inputs[0].portId = "nope";
      }),
      "invalid-workflow-reference",
    ],
    [
      variant((workflow) => {
        workflow.workflows["countdown@1"].order = ["start"];
      }),
      "missing-order-id",
    ],
    [{ ...structuredClone(fixture), version: 2 }, "invalid-workflow-reference"],
  ];
  for (const [workflow, code] of cases) {
    const result = validateExecutableWorkflow(workflow);
    assert.equal(result.ok, false, code);
    if (!result.ok) {
      assert.ok(
        result.diagnostics.some((diagnostic) => diagnostic.code === code),
        `${code}: ${JSON.stringify(result.diagnostics)}`,
      );
    }
  }
});
