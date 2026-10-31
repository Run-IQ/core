import type { JsonValue } from '@run-iq/spec';

type JsonObject = { [k: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return isPlainObject(value);
}

/** Sets an own data property, even for `__proto__`: plain assignment would set the prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** A copy of the arrays and plain objects of `value`; other values are kept as they are. */
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => clone(item));
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) setOwn(copy, key, clone(item));
    return copy;
  }
  return value;
}

/**
 * A new object: `base` with `patch` merged in. Plain objects merge recursively; arrays and
 * scalars of `patch` replace what `base` holds. A `base` that is not a plain object counts as
 * `{}`. Neither input is mutated, and the result shares no array or plain object with them.
 * Every key is written as an own data property, so `__proto__`, `constructor` or `prototype` in
 * `patch` are kept as data and never reach a prototype.
 */
export function deepMerge(base: unknown, patch: JsonObject): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  if (isPlainObject(base)) {
    for (const [key, value] of Object.entries(base)) setOwn(merged, key, clone(value));
  }
  for (const [key, value] of Object.entries(patch)) {
    const current = Object.hasOwn(merged, key) ? merged[key] : undefined;
    setOwn(
      merged,
      key,
      isPlainObject(current) && isJsonObject(value) ? deepMerge(current, value) : clone(value),
    );
  }
  return merged;
}
