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

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** What a non-JSON value is, for messages: `undefined`, `NaN`, `Date`, `cycle`... */
function kindOf(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'object' || value === null) return typeof value;
  const proto: unknown = Object.getPrototypeOf(value);
  const name: unknown =
    typeof proto === 'object' && proto !== null ? Reflect.get(proto, 'constructor') : undefined;
  return typeof name === 'function' && name.name !== '' ? name.name : 'object';
}

/**
 * Where `value` stops being JSON data, as `<path> (<kind>)` with the path from `$`
 * (`$.a.b[1] (undefined)`, `$ (NaN)`, `$.self (cycle)`), or `undefined` when it is JSON data:
 * `null`, a boolean, a string, a finite number, or arrays and plain objects (prototype
 * `Object.prototype` or `null`) of JSON data, without cycles. A `Date`, a `Map`, a class
 * instance or `undefined` is not.
 */
export function findNonJson(
  value: unknown,
  path = '$',
  ancestors: Set<object> = new Set(),
): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : `${path} (${kindOf(value)})`;
  }
  if (typeof value !== 'object') return `${path} (${kindOf(value)})`;
  if (ancestors.has(value)) return `${path} (cycle)`;
  if (!Array.isArray(value)) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return `${path} (${kindOf(value)})`;
  }
  ancestors.add(value);
  let found: string | undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && found === undefined; i += 1) {
      found = findNonJson(value[i], `${path}[${i}]`, ancestors);
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      const at = IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
      found = findNonJson(item, at, ancestors);
      if (found !== undefined) break;
    }
  }
  ancestors.delete(value);
  return found;
}

/** True when `value` is JSON data (see `findNonJson`). */
export function isJsonValue(value: unknown): value is JsonValue {
  return findNonJson(value) === undefined;
}

/**
 * `canonicalize` of a value for messages, or `String(value)` when it is not JSON (`NaN`...), or
 * `(unprintable value)` when even that throws. Never throws.
 */
export function describeValue(value: unknown): string {
  try {
    return canonicalize(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '(unprintable value)';
    }
  }
}
