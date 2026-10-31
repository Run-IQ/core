import type { Rule } from '../types/rule.js';

/** True for an object that is neither `null` nor an array (any prototype). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A rule as messages name it: `id@version`. */
export const ruleLabel = (rule: Rule): string => `${rule.id}@${rule.version}`;
