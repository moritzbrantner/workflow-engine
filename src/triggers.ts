import { createHash } from "node:crypto";

import { assertValidCron } from "./cron.js";
import { stableStringify } from "./digest.js";
import type { WorkflowTrigger, WorkflowTriggerInput } from "./types.js";

export function normalizeTrigger(
  input: WorkflowTriggerInput,
  createId: () => string,
): WorkflowTrigger {
  const base = {
    id: input.id ?? createId(),
    workflowId: input.workflowId,
    ...(input.workflowVersion === undefined ? {} : { workflowVersion: input.workflowVersion }),
    enabled: input.enabled ?? true,
  };

  switch (input.type) {
    case "manual":
      return { ...base, type: "manual" };
    case "cron":
      assertValidCron(input.cron);
      return { ...base, type: "cron", cron: input.cron };
    case "webhook":
      if (!input.path.startsWith("/")) {
        throw new Error("Webhook trigger paths must start with '/'.");
      }
      return {
        ...base,
        type: "webhook",
        path: input.path,
        method: (input.method ?? "POST").toUpperCase(),
      };
  }
}

export function scheduledMinute(date: Date): string {
  const scheduledAt = new Date(date);
  scheduledAt.setUTCSeconds(0, 0);
  return scheduledAt.toISOString();
}

export function scheduleIdempotencyKey(triggerId: string, scheduledAt: string): string {
  const digest = createHash("sha256")
    .update(stableStringify({ triggerId, scheduledAt }))
    .digest("hex");
  return `schedule:${digest}`;
}
