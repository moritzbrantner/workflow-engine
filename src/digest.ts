import { createHash } from "node:crypto";

import type { ExecutableWorkflow } from "./types.js";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function digestExecutableWorkflow(workflow: ExecutableWorkflow): string {
  return createHash("sha256").update(stableStringify(workflow)).digest("hex");
}
