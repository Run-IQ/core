import { canonicalize } from '@run-iq/spec';
import type { JsonValue } from '@run-iq/spec';

/**
 * Canonical JSON of a value: `canonicalize` of `@run-iq/spec` (keys sorted at every depth,
 * `Date` as ISO string), or `undefined` for `undefined`. Throws `SpecError`
 * (`NON_SERIALIZABLE`) on `NaN`, `Infinity`, `bigint`, `Map`, `Set`, class instances and cycles.
 */
export function canonicalStringify(obj: unknown): string | undefined {
  return obj === undefined ? undefined : canonicalize(obj);
}

/**
 * True when `value` is JSON data: `null`, a boolean, a string, a finite number, or arrays and
 * plain objects (prototype `Object.prototype` or `null`) of JSON data, without cycles. A `Date`,
 * a `Map` or a class instance is not.
 */
export function isJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  if (!Array.isArray(value)) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
  }
  ancestors.add(value);
  const valid = Object.values(value).every((item: unknown) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}
