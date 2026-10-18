/**
 * Ephemeral, in-process live status of runs that are currently being dispatched (#24).
 *
 * Live state is derived from lifecycle observations the dispatcher reports while it runs. It is
 * bounded (one entry per node, no payloads), never written to the store, and dropped once the
 * terminal run record is persisted. After a restart only persisted run records remain.
 */

/** A lifecycle observation reported by a dispatcher, structurally compatible with Runner events. */
export type WorkflowRunLiveEvent = {
  type: string;
  nodeId?: string;
  attempt?: number;
  timestamp?: string;
};

export type WorkflowLiveNodeState =
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "skipped"
  | "suspended";

export type WorkflowLiveNodeStatus = {
  state: WorkflowLiveNodeState;
  attempt?: number;
  updatedAt?: string;
};

export type WorkflowLiveRunStatus = {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  /** `running` while dispatched; the persisted terminal status in the final notification. */
  status: string;
  nodes: Record<string, WorkflowLiveNodeStatus>;
  /** Number of observations received for this run. */
  observations: number;
};

export type WorkflowLiveRunListener = (status: WorkflowLiveRunStatus) => void;

const nodeStates: Record<string, WorkflowLiveNodeState> = {
  "node.started": "running",
  "node.retrying": "retrying",
  "node.succeeded": "succeeded",
  "node.failed": "failed",
  "node.skipped": "skipped",
  "node.suspended": "suspended",
};

export class WorkflowLiveRuns {
  readonly #runs = new Map<string, WorkflowLiveRunStatus>();
  readonly #listeners = new Map<string, Set<WorkflowLiveRunListener>>();

  begin(runId: string, workflowId: string, workflowVersion: number): void {
    this.#runs.set(runId, {
      runId,
      workflowId,
      workflowVersion,
      status: "running",
      nodes: {},
      observations: 0,
    });
    this.#notify(runId);
  }

  observe(runId: string, event: unknown): void {
    const run = this.#runs.get(runId);
    if (!run || typeof event !== "object" || event === null) {
      return;
    }
    const { type, nodeId, attempt, timestamp } = event as WorkflowRunLiveEvent;
    run.observations += 1;
    const state = typeof type === "string" ? nodeStates[type] : undefined;
    if (state && typeof nodeId === "string") {
      run.nodes[nodeId] = {
        state,
        ...(typeof attempt === "number" ? { attempt } : {}),
        ...(typeof timestamp === "string" ? { updatedAt: timestamp } : {}),
      };
    }
    this.#notify(runId);
  }

  /** Publishes the persisted terminal status, then forgets the run's live state. */
  finish(runId: string, status: string): void {
    const run = this.#runs.get(runId);
    if (!run) {
      return;
    }
    run.status = status;
    this.#notify(runId);
    this.#runs.delete(runId);
    this.#listeners.delete(runId);
  }

  get(runId: string): WorkflowLiveRunStatus | undefined {
    const run = this.#runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  subscribe(runId: string, listener: WorkflowLiveRunListener): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  #notify(runId: string): void {
    const run = this.#runs.get(runId);
    const listeners = this.#listeners.get(runId);
    if (!run || !listeners) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(structuredClone(run));
      } catch {
        // A failing observer never affects dispatch or persistence.
      }
    }
  }
}
