import type { Rule } from '../types/rule.js';

/** True for an object that is neither `null` nor an array (any prototype). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A rule as messages name it: `id@version`. */
export const ruleLabel = (rule: Rule): string => `${rule.id}@${rule.version}`;

/**
 * What a thrown value says, for messages: its `message` for an `Error`, else `String(error)`,
 * or `(unprintable error)` when even that throws. Never throws.
 */
export function describeThrown(error: unknown): string {
  // Everything inside the try: `instanceof` and `message` run traps of hostile proxies.
  try {
    if (error instanceof Error) return String(error.message);
    return String(error);
  } catch {
    return '(unprintable error)';
  }
}

/** True for an object that is neither `null` nor an array; never throws (no prototype read). */
export function isObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * A copy of `value` that shares no array, plain object (prototype `Object.prototype` or `null`)
 * or `Date` with it, so that writes to the copy never reach the original. Other objects (class
 * instances, functions) are kept by reference: they are not data the engine owns. Shared and
 * cyclic references are copied once and keep their shape.
 */
export function copyData<T>(value: T): T {
  // justification: copyUnknown returns a value of the same shape as its argument.
  return copyUnknown(value, new Map()) as T;
}

function copyUnknown(value: unknown, copies: Map<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const known = copies.get(value);
  if (known !== undefined) return known;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const item of value) copy.push(copyUnknown(item, copies));
    return copy;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy: Record<string, unknown> = {};
  if (proto === null) Object.setPrototypeOf(copy, null);
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = copyUnknown(item, copies);
  return copy;
}
