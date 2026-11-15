import { describeFault, faultOf } from '../engine/pluginPort.js';
import type { Rule } from '../types/rule.js';

/** True for an object that is neither `null` nor an array (any prototype). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A rule as messages name it: `id@version`. */
export const ruleLabel = (rule: Rule): string => `${rule.id}@${rule.version}`;

/**
 * What a thrown value says, for messages: the bounded text of its fault (`message`, else `name`),
 * or `(unprintable error)` when even that fails. Never throws, never runs its conversions.
 */
export function describeThrown(error: unknown): string {
  // The text of a fault, never a conversion of it: `name`, `message` and `code` are read as own
  // data string properties and bounded (`faultOf`); no `toString` or `Symbol.toPrimitive` of the
  // thrown object is run, and nothing it holds is longer than the bound.
  try {
    return describeFault(faultOf(error));
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
