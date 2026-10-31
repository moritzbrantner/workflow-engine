import { WorkflowDispatchError } from "./engine-errors.js";
import { assertJsonSafe, clone } from "./json-value.js";
import type { WorkflowDefinition, WorkflowRunWait } from "./types.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the runner checkpoint's `waiting` and attaches the waiting node's compiled task. */
export function waitFromCheckpoint(
  definition: WorkflowDefinition,
  checkpoint: unknown,
  since: string,
): WorkflowRunWait {
  const waiting = isPlainRecord(checkpoint) ? checkpoint.waiting : undefined;
  if (
    !isPlainRecord(waiting) ||
    typeof waiting.nodeId !== "string" ||
    typeof waiting.taskId !== "string"
  ) {
    throw new WorkflowDispatchError(
      "Dispatcher returned a suspension without a waiting node and task id.",
      "unknown",
    );
  }
  const node = definition.workflow.nodes.find((candidate) => candidate.id === waiting.nodeId);
  return {
    nodeId: waiting.nodeId,
    taskId: waiting.taskId,
    ...(node?.humanTask === undefined ? {} : { humanTask: clone(node.humanTask) }),
    ...(waiting.request === undefined ? {} : { request: clone(waiting.request) }),
    checkpoint: clone(checkpoint),
    since,
  };
}

/** Structural checks of the workflow-editor human task response contract (editor #105). */
export function validateTaskResponse(humanTask: unknown, response: unknown): string[] {
  if (!isPlainRecord(response)) {
    return ["The response must be an object."];
  }
  const problems: string[] = [];
  try {
    assertJsonSafe(response, "response");
  } catch {
    problems.push("The response must be JSON.");
  }
  if (response.comment !== undefined && typeof response.comment !== "string") {
    problems.push("The response comment must be text.");
  }
  const kind = isPlainRecord(humanTask) ? humanTask.kind : undefined;
  if (kind === "approval" && response.decision !== "approved" && response.decision !== "rejected") {
    problems.push('The response decision must be "approved" or "rejected".');
  }
  if (kind === "input" && !Object.prototype.hasOwnProperty.call(response, "value")) {
    problems.push("The response needs a value.");
  }
  return problems;
}
