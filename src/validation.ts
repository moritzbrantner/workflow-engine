import type { ExecutableWorkflow } from "./types.js";

export type ExecutableWorkflowDiagnosticCode =
  | "malformed-envelope"
  | "unsupported-format"
  | "unsupported-version"
  | "malformed-nodes"
  | "malformed-node"
  | "duplicate-node-id"
  | "malformed-port-list"
  | "malformed-port"
  | "duplicate-port-id"
  | "malformed-edges"
  | "malformed-edge"
  | "duplicate-edge-id"
  | "missing-edge-endpoint"
  | "invalid-edge-port"
  | "malformed-order"
  | "duplicate-order-id"
  | "unknown-order-id"
  | "missing-order-id"
  | "invalid-iteration"
  | "nested-iteration-not-supported"
  | "invalid-workflow-reference"
  | "unbounded-recursive-reference";

export type ExecutableWorkflowDiagnostic = {
  code: ExecutableWorkflowDiagnosticCode;
  path: string;
  message: string;
};

export type ExecutableWorkflowValidationResult =
  | { ok: true; workflow: ExecutableWorkflow }
  | { ok: false; diagnostics: readonly ExecutableWorkflowDiagnostic[] };

export class InvalidExecutableWorkflowError extends Error {
  readonly code = "INVALID_EXECUTABLE_WORKFLOW";
  readonly diagnostics: readonly ExecutableWorkflowDiagnostic[];

  constructor(diagnostics: readonly ExecutableWorkflowDiagnostic[]) {
    super("Compiled workflow is invalid.");
    this.name = "InvalidExecutableWorkflowError";
    this.diagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }
}

type JsonRecord = Record<string, unknown>;

type NodePorts = {
  inputs: Set<string> | null;
  outputs: Set<string> | null;
};

type ValidEdge = {
  path: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function diagnostic(
  code: ExecutableWorkflowDiagnosticCode,
  path: string,
  message: string,
): ExecutableWorkflowDiagnostic {
  return { code, path, message };
}

function validatePorts(
  value: unknown,
  path: string,
  diagnostics: ExecutableWorkflowDiagnostic[],
): Set<string> | null {
  if (value === undefined) {
    return new Set();
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic("malformed-port-list", path, "Workflow ports must be an array when present."),
    );
    return null;
  }

  const ids = new Set<string>();
  for (const [index, port] of value.entries()) {
    const portPath = `${path}/${index}`;
    if (!isRecord(port) || !isNonEmptyString(port.id)) {
      diagnostics.push(
        diagnostic("malformed-port", portPath, "Workflow ports require a non-empty string id."),
      );
      continue;
    }
    if (port.optional !== undefined && typeof port.optional !== "boolean") {
      diagnostics.push(
        diagnostic(
          "malformed-port",
          `${portPath}/optional`,
          "Workflow port optional must be a boolean when present.",
        ),
      );
    }
    if (ids.has(port.id)) {
      diagnostics.push(
        diagnostic(
          "duplicate-port-id",
          `${portPath}/id`,
          `Duplicate port id '${port.id}' in the same port list.`,
        ),
      );
      continue;
    }
    ids.add(port.id);
  }

  return ids;
}

/** `none`: compiled v1, where iteration is invalid; otherwise iteration may nest (editor #97). */
type IterationScope = "none" | "top-level" | "body";

/** Validates nodes, edges and order of one graph scope; returns ports by node id. */
function validateGraph(
  value: JsonRecord,
  base: string,
  diagnostics: ExecutableWorkflowDiagnostic[],
  iteration: IterationScope,
): Map<string, NodePorts> {
  const nodeIds = new Set<string>();
  const nodesById = new Map<string, NodePorts>();

  if (!Array.isArray(value.nodes)) {
    diagnostics.push(
      diagnostic("malformed-nodes", `${base}/nodes`, "Compiled workflow nodes must be an array."),
    );
  } else {
    for (const [index, node] of value.nodes.entries()) {
      const nodePath = `${base}/nodes/${index}`;
      if (!isRecord(node) || !isNonEmptyString(node.id) || !isNonEmptyString(node.kind)) {
        diagnostics.push(
          diagnostic(
            "malformed-node",
            nodePath,
            "Workflow nodes require non-empty string id and kind values.",
          ),
        );
        continue;
      }

      if (node.label !== undefined && typeof node.label !== "string") {
        diagnostics.push(
          diagnostic(
            "malformed-node",
            `${nodePath}/label`,
            "Workflow node label must be a string when present.",
          ),
        );
      }
      if (node.data !== undefined && !isRecord(node.data)) {
        diagnostics.push(
          diagnostic(
            "malformed-node",
            `${nodePath}/data`,
            "Workflow node data must be an object when present.",
          ),
        );
      }

      const inputs = validatePorts(node.inputs, `${nodePath}/inputs`, diagnostics);
      const outputs = validatePorts(node.outputs, `${nodePath}/outputs`, diagnostics);
      if (node.kind === "control.iterate" || node.iteration !== undefined) {
        validateIterationNode(node, nodePath, inputs, diagnostics, iteration);
      }

      if (nodeIds.has(node.id)) {
        diagnostics.push(
          diagnostic(
            "duplicate-node-id",
            `${nodePath}/id`,
            `Duplicate workflow node id '${node.id}'.`,
          ),
        );
      } else {
        nodeIds.add(node.id);
        nodesById.set(node.id, { inputs, outputs });
      }
    }
  }

  const validEdges: ValidEdge[] = [];
  const edgeIds = new Set<string>();
  if (!Array.isArray(value.edges)) {
    diagnostics.push(
      diagnostic("malformed-edges", `${base}/edges`, "Compiled workflow edges must be an array."),
    );
  } else {
    for (const [index, edge] of value.edges.entries()) {
      const edgePath = `${base}/edges/${index}`;
      if (
        !isRecord(edge) ||
        !isNonEmptyString(edge.id) ||
        !isNonEmptyString(edge.sourceNodeId) ||
        !isNonEmptyString(edge.sourcePortId) ||
        !isNonEmptyString(edge.targetNodeId) ||
        !isNonEmptyString(edge.targetPortId)
      ) {
        diagnostics.push(
          diagnostic(
            "malformed-edge",
            edgePath,
            "Workflow edges require non-empty id, node id, and port id strings.",
          ),
        );
        continue;
      }

      if (edgeIds.has(edge.id)) {
        diagnostics.push(
          diagnostic(
            "duplicate-edge-id",
            `${edgePath}/id`,
            `Duplicate workflow edge id '${edge.id}'.`,
          ),
        );
      } else {
        edgeIds.add(edge.id);
      }

      validEdges.push({
        path: edgePath,
        sourceNodeId: edge.sourceNodeId,
        sourcePortId: edge.sourcePortId,
        targetNodeId: edge.targetNodeId,
        targetPortId: edge.targetPortId,
      });
    }
  }

  for (const edge of validEdges) {
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);

    if (!source) {
      diagnostics.push(
        diagnostic(
          "missing-edge-endpoint",
          `${edge.path}/sourceNodeId`,
          `Edge source node '${edge.sourceNodeId}' does not exist.`,
        ),
      );
    } else if (source.outputs && !source.outputs.has(edge.sourcePortId)) {
      diagnostics.push(
        diagnostic(
          "invalid-edge-port",
          `${edge.path}/sourcePortId`,
          `Source port '${edge.sourcePortId}' does not exist on node '${edge.sourceNodeId}'.`,
        ),
      );
    }

    if (!target) {
      diagnostics.push(
        diagnostic(
          "missing-edge-endpoint",
          `${edge.path}/targetNodeId`,
          `Edge target node '${edge.targetNodeId}' does not exist.`,
        ),
      );
    } else if (target.inputs && !target.inputs.has(edge.targetPortId)) {
      diagnostics.push(
        diagnostic(
          "invalid-edge-port",
          `${edge.path}/targetPortId`,
          `Target port '${edge.targetPortId}' does not exist on node '${edge.targetNodeId}'.`,
        ),
      );
    }
  }

  if (!Array.isArray(value.order)) {
    diagnostics.push(
      diagnostic("malformed-order", `${base}/order`, "Compiled workflow order must be an array."),
    );
  } else {
    const orderIds = new Set<string>();
    for (const [index, nodeId] of value.order.entries()) {
      const path = `${base}/order/${index}`;
      if (!isNonEmptyString(nodeId)) {
        diagnostics.push(
          diagnostic("malformed-order", path, "Workflow order entries must be non-empty strings."),
        );
        continue;
      }
      if (orderIds.has(nodeId)) {
        diagnostics.push(
          diagnostic(
            "duplicate-order-id",
            path,
            `Workflow order contains duplicate node id '${nodeId}'.`,
          ),
        );
      } else {
        orderIds.add(nodeId);
      }
      if (!nodeIds.has(nodeId)) {
        diagnostics.push(
          diagnostic(
            "unknown-order-id",
            path,
            `Workflow order references unknown node id '${nodeId}'.`,
          ),
        );
      }
    }

    for (const nodeId of nodeIds) {
      if (!orderIds.has(nodeId)) {
        diagnostics.push(
          diagnostic(
            "missing-order-id",
            `${base}/order`,
            `Workflow order is missing node id '${nodeId}'.`,
          ),
        );
      }
    }
  }

  return nodesById;
}

/**
 * Validates the editor compiled-v2 bounded iteration construct (workflow-editor docs/compiler.md)
 * structurally. The engine stores and dispatches it unchanged; Runner executes it.
 */
function validateIterationNode(
  node: JsonRecord,
  nodePath: string,
  inputs: Set<string> | null,
  diagnostics: ExecutableWorkflowDiagnostic[],
  scope: IterationScope,
): void {
  const invalid = (path: string, message: string) =>
    diagnostics.push(diagnostic("invalid-iteration", `${nodePath}${path}`, message));
  if (scope === "none") {
    if (node.iteration !== undefined) {
      invalid("/iteration", "Bounded iteration requires compiled workflow version 2.");
    }
    return;
  }
  if (node.kind !== "control.iterate") {
    invalid("/kind", "Only control.iterate nodes may declare an iteration.");
    return;
  }
  const iteration = node.iteration;
  if (!isRecord(iteration)) {
    invalid("/iteration", "control.iterate requires an iteration object.");
    return;
  }
  const max = iteration.maxIterations;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    invalid(
      "/iteration/maxIterations",
      "Iteration requires a finite whole-number maxIterations of at least 1.",
    );
  }
  if (
    !isRecord(iteration.state) ||
    iteration.state.inputPortId !== "state" ||
    !(inputs?.has("state") ?? false)
  ) {
    invalid("/iteration/state", "Iteration state must use the node's 'state' input port.");
  }
  const stop = iteration.stop;
  const stopKind = isRecord(stop) ? stop.kind : undefined;
  if (
    !isRecord(stop) ||
    !((stop.kind === "body-output" && stop.outputId === "converged") || stop.kind === "limit-only")
  ) {
    invalid("/iteration/stop", "Iteration stop must be body-output 'converged' or limit-only.");
  }
  if (iteration.candidate !== "latest-state") {
    invalid("/iteration/candidate", "Iteration candidate must be 'latest-state'.");
  }
  if (
    !isRecord(iteration.result) ||
    !isNonEmptyString(iteration.result.outputPortId) ||
    !Array.isArray(iteration.result.statuses)
  ) {
    invalid("/iteration/result", "Iteration result requires an output port and statuses.");
  }
  const body = iteration.body;
  if (!isRecord(body)) {
    invalid("/iteration/body", "Iteration requires a body graph.");
    return;
  }
  const bodyPorts = validateGraph(body, `${nodePath}/iteration/body`, diagnostics, "body");
  const boundary = (value: unknown, path: string, direction: "inputs" | "outputs") => {
    const ports =
      isRecord(value) && isNonEmptyString(value.nodeId)
        ? bodyPorts.get(value.nodeId)?.[direction]
        : undefined;
    if (!isRecord(value) || !isNonEmptyString(value.portId) || !ports?.has(value.portId)) {
      invalid(
        path,
        `Iteration boundary must reference an existing body ${direction === "inputs" ? "input" : "output"} port.`,
      );
    }
  };
  if (!Array.isArray(body.inputs)) {
    invalid("/iteration/body/inputs", "Iteration body inputs must be an array.");
  } else {
    for (const [index, input] of body.inputs.entries()) {
      const path = `/iteration/body/inputs/${index}`;
      boundary(input, path, "inputs");
      if (!isRecord(input) || !isNonEmptyString(input.id) || !(inputs?.has(input.id) ?? false)) {
        invalid(
          `${path}/id`,
          "Iteration body input must name an input port of the iteration node.",
        );
      }
    }
  }
  const outputs = body.outputs;
  if (!isRecord(outputs)) {
    invalid("/iteration/body/outputs", "Iteration body outputs must be an object.");
    return;
  }
  boundary(outputs.next, "/iteration/body/outputs/next", "outputs");
  if (stopKind === "body-output" || outputs.converged !== undefined) {
    boundary(outputs.converged, "/iteration/body/outputs/converged", "outputs");
  }
}

const portIdsOf = (ports: unknown) =>
  new Set(
    (Array.isArray(ports) ? ports : []).flatMap((port) =>
      isRecord(port) && typeof port.id === "string" ? [port.id] : [],
    ),
  );

/**
 * Structural checks for the compiled-v3 Workflow Reference closure (workflow-editor TECH-005).
 * The engine stores and dispatches it unchanged; Runner executes references and enforces maxDepth.
 */
function validateReferences(value: JsonRecord, diagnostics: ExecutableWorkflowDiagnostic[]): void {
  const invalid = (path: string, message: string) =>
    diagnostics.push(diagnostic("invalid-workflow-reference", path, message));
  const workflows = isRecord(value.workflows) ? value.workflows : undefined;
  if (value.version === 3 && !workflows) {
    invalid("/workflows", "Compiled workflow version 3 requires a workflows closure object.");
    return;
  }
  const edges = new Map<string, Array<{ to: string; bounded: boolean }>>();
  // Reference nodes may also sit in iteration bodies at any depth (editor #141); they resolve
  // against the root closure and count as edges of the enclosing graph.
  const referencesIn = (
    nodes: unknown,
    base: string,
    references: Array<{ to: string; bounded: boolean }>,
  ) => {
    (Array.isArray(nodes) ? nodes : []).forEach((node, index) => {
      if (isRecord(node) && isRecord(node.iteration) && isRecord(node.iteration.body)) {
        referencesIn(
          node.iteration.body.nodes,
          `${base}/nodes/${index}/iteration/body`,
          references,
        );
      }
      if (!isRecord(node) || node.workflowRef === undefined) {
        return;
      }
      const path = `${base}/nodes/${index}/workflowRef`;
      const reference = node.workflowRef;
      if (value.version !== 3) {
        invalid(path, "Workflow references require compiled workflow version 3.");
        return;
      }
      if (!isRecord(reference) || typeof reference.workflow !== "string") {
        invalid(path, "A workflow reference must name a workflow key.");
        return;
      }
      const maxDepth = reference.maxDepth;
      if (
        maxDepth !== undefined &&
        (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 1)
      ) {
        invalid(`${path}/maxDepth`, "maxDepth must be a whole number of at least 1.");
      }
      if (!workflows || !isRecord(workflows[reference.workflow])) {
        invalid(`${path}/workflow`, `Workflow ${reference.workflow} is not in the closure.`);
        return;
      }
      references.push({ to: reference.workflow, bounded: maxDepth !== undefined });
    });
  };
  const checkNodes = (nodes: unknown, base: string, key: string) => {
    const references: Array<{ to: string; bounded: boolean }> = [];
    referencesIn(nodes, base, references);
    edges.set(key, references);
  };
  checkNodes(value.nodes, "", "");
  for (const [key, definition] of Object.entries(workflows ?? {})) {
    const base = `/workflows/${key}`;
    if (!isRecord(definition)) {
      invalid(base, `Workflow definition ${key} must be an object.`);
      continue;
    }
    validateGraph(definition, base, diagnostics, "top-level");
    checkNodes(definition.nodes, base, key);
    const contract = definition.interface;
    if (
      !isRecord(contract) ||
      !Array.isArray(contract.inputs) ||
      !Array.isArray(contract.outputs)
    ) {
      invalid(`${base}/interface`, `Workflow definition ${key} needs an interface.`);
      continue;
    }
    const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
    for (const [side, list, portSide] of [
      ["inputs", contract.inputs, "outputs"],
      ["outputs", contract.outputs, "inputs"],
    ] as const) {
      list.forEach((port, index) => {
        const node = isRecord(port)
          ? nodes.find((candidate) => isRecord(candidate) && candidate.id === port.nodeId)
          : undefined;
        if (
          !isRecord(port) ||
          !isNonEmptyString(port.id) ||
          !isRecord(node) ||
          typeof port.portId !== "string" ||
          !portIdsOf(node[portSide]).has(port.portId)
        ) {
          invalid(
            `${base}/interface/${side}/${index}`,
            "Interface entries must reference an existing start output or end input port.",
          );
        }
      });
    }
  }

  // A reference cycle compiles only when at least one reference on it declares maxDepth.
  const visit = (key: string, stack: string[], bounds: boolean[]): void => {
    for (const { to, bounded } of edges.get(key) ?? []) {
      const index = stack.indexOf(to);
      if (index >= 0) {
        if (![...bounds.slice(index + 1), bounded].some(Boolean)) {
          diagnostics.push(
            diagnostic(
              "unbounded-recursive-reference",
              "/workflows",
              `Recursive workflow reference ${[...stack.slice(index), to].join(" → ")} has no finite maxDepth bound.`,
            ),
          );
        }
        continue;
      }
      visit(to, [...stack, to], [...bounds, bounded]);
    }
  };
  visit("", [""], [false]);
}

export function validateExecutableWorkflow(value: unknown): ExecutableWorkflowValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("malformed-envelope", "/", "Compiled workflow must be a non-null object."),
      ],
    };
  }

  if (value.format !== "@moritzbrantner/workflow/compiled") {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "unsupported-format",
          "/format",
          "Unsupported workflow format; expected '@moritzbrantner/workflow/compiled'.",
        ),
      ],
    };
  }

  if (value.version !== 1 && value.version !== 2 && value.version !== 3) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "unsupported-version",
          "/version",
          `Unsupported compiled workflow version: ${String(value.version)}.`,
        ),
      ],
    };
  }

  const diagnostics: ExecutableWorkflowDiagnostic[] = [];
  validateGraph(value, "", diagnostics, value.version === 1 ? "none" : "top-level");
  validateReferences(value, diagnostics);

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return { ok: true, workflow: structuredClone(value) as ExecutableWorkflow };
}

export function assertExecutableWorkflow(value: unknown): ExecutableWorkflow {
  const result = validateExecutableWorkflow(value);
  if (!result.ok) {
    throw new InvalidExecutableWorkflowError(result.diagnostics);
  }
  return result.workflow;
}
