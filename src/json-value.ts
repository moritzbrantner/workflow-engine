import { WorkflowValueNotJsonSafeError } from "./store-errors.js";

function describe(value: unknown): string | undefined {
  if (value === null) return undefined;
  switch (typeof value) {
    case "string":
    case "boolean":
      return undefined;
    case "number":
      if (!Number.isFinite(value)) return `${String(value)} is not a finite number`;
      if (Object.is(value, -0)) return "-0 does not survive JSON encoding";
      return undefined;
    case "undefined":
      return "undefined is not representable in JSON";
    case "bigint":
    case "symbol":
    case "function":
      return `${typeof value} is not representable in JSON`;
    default:
      return undefined;
  }
}

function findNonJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): WorkflowValueNotJsonSafeError | undefined {
  const reason = describe(value);
  if (reason) return new WorkflowValueNotJsonSafeError(path, reason);
  if (typeof value !== "object" || value === null) return undefined;

  if (ancestors.has(value)) {
    return new WorkflowValueNotJsonSafeError(path, "circular references are not representable in JSON");
  }

  if (Array.isArray(value)) {
    const extraKeys = Object.keys(value).length !== value.length;
    if (extraKeys || Object.getOwnPropertySymbols(value).length > 0) {
      return new WorkflowValueNotJsonSafeError(path, "arrays must be dense and have no extra properties");
    }
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        ancestors.delete(value);
        return new WorkflowValueNotJsonSafeError(`${path}[${index}]`, "sparse array holes are not representable in JSON");
      }
      const nested = findNonJsonValue(value[index], `${path}[${index}]`, ancestors);
      if (nested) {
        ancestors.delete(value);
        return nested;
      }
    }
    ancestors.delete(value);
    return undefined;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    const name =
      typeof value.constructor === "function" && value.constructor.name
        ? value.constructor.name
        : "non-plain object";
    return new WorkflowValueNotJsonSafeError(path, `${name} instances are not plain JSON objects`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return new WorkflowValueNotJsonSafeError(path, "symbol keys are not representable in JSON");
  }

  ancestors.add(value);
  for (const [key, nestedValue] of Object.entries(value)) {
    const nested = findNonJsonValue(nestedValue, `${path}.${key}`, ancestors);
    if (nested) {
      ancestors.delete(value);
      return nested;
    }
  }
  ancestors.delete(value);
  return undefined;
}

/**
 * Throws WorkflowValueNotJsonSafeError unless JSON encoding round-trips the value exactly.
 * Durable stores persist JSON, so the engine contract only accepts JSON-safe payloads.
 */
export function assertJsonSafe(value: unknown, path: string): void {
  const error = findNonJsonValue(value, path, new Set());
  if (error) throw error;
}

/** Like assertJsonSafe, but accepts a top-level undefined for an optional record field. */
export function assertOptionalJsonSafe(value: unknown, path: string): void {
  if (value !== undefined) assertJsonSafe(value, path);
}

/**
 * Store records must survive JSON persistence unchanged, so every adapter rejects values JSON
 * would silently alter (nested undefined, NaN, class instances, ...). Top-level undefined fields
 * mean an absent optional field and round-trip unchanged.
 */
export function assertStorableRecord(record: object, kind: string): void {
  for (const [field, value] of Object.entries(record)) {
    assertOptionalJsonSafe(value, `${kind}.${field}`);
  }
}
