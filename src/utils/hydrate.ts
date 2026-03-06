import type { Rule } from '../types/rule.js';

export function hydrateRule(raw: Record<string, unknown>): Rule {
  return {
    ...raw,
    effectiveFrom: new Date(raw.effectiveFrom as string),
    effectiveUntil: raw.effectiveUntil != null ? new Date(raw.effectiveUntil as string) : null,
  } as Rule;
}

export function hydrateRules(rawRules: Record<string, unknown>[]): Rule[] {
  return rawRules.map(hydrateRule);
}
