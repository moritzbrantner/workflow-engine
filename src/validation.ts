import type { ExecutableWorkflow } from "./index.js";

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
  | "missing-order-id";

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
  if (value === undefined) return new Set();
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

export function validateExecutableWorkflow(value: unknown): ExecutableWorkflowValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "malformed-envelope",
          "/",
          "Compiled workflow must be a non-null object.",
        ),
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

  if (value.version !== 1) {
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
  const nodeIds = new Set<string>();
  const nodesById = new Map<string, NodePorts>();

  if (!Array.isArray(value.nodes)) {
    diagnostics.push(
      diagnostic("malformed-nodes", "/nodes", "Compiled workflow nodes must be an array."),
    );
  } else {
    for (const [index, node] of value.nodes.entries()) {
      const nodePath = `/nodes/${index}`;
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
      diagnostic("malformed-edges", "/edges", "Compiled workflow edges must be an array."),
    );
  } else {
    for (const [index, edge] of value.edges.entries()) {
      const edgePath = `/edges/${index}`;
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
      diagnostic("malformed-order", "/order", "Compiled workflow order must be an array."),
    );
  } else {
    const orderIds = new Set<string>();
    for (const [index, nodeId] of value.order.entries()) {
      const path = `/order/${index}`;
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
            "/order",
            `Workflow order is missing node id '${nodeId}'.`,
          ),
        );
      }
    }
  }

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
