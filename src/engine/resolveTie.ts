import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import { RuleConflictError } from '../errors/RuleConflictError.js';

/** The one rule-identity order of the engine: id by code-unit order, then version ascending. */
export function compareRuleIdentity(a: Rule, b: Rule): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.version - b.version;
}

/** The engine's processing order: priority descending, then `compareRuleIdentity`. */
export function compareByPriorityThenIdentity(a: Rule, b: Rule): number {
  return b.priority - a.priority || compareRuleIdentity(a, b);
}

/**
 * Resolves a tie between rules that share the same priority.
 * 'throw' raises a RuleConflictError naming every tied rule (in identity order); 'first' keeps the
 * lowest id@version and skips the others with RULE_CONFLICT. Rules of different priorities are a
 * programming error, not a rule conflict.
 */
export function resolveTie(
  rules: readonly Rule[],
  mode: 'throw' | 'first',
): { winner: Rule; losers: SkippedRule[] } {
  const [winner, ...losersRules] = [...rules].sort(compareRuleIdentity);
  if (winner === undefined) {
    throw new Error('resolveTie requires at least one rule');
  }
  if (rules.some((r) => r.priority !== winner.priority)) {
    throw new Error(
      `resolveTie requires rules sharing one priority: ${[winner, ...losersRules].map((r) => r.id).join(', ')}`,
    );
  }
  if (mode === 'throw' && losersRules.length > 0) {
    throw new RuleConflictError(
      [winner, ...losersRules].map((r) => r.id),
      winner.priority,
    );
  }
  const losers: SkippedRule[] = losersRules.map((rule) => ({
    rule,
    reason: 'RULE_CONFLICT',
    detail: `tied with ${winner.id}@${winner.version} at priority ${winner.priority}; the lowest id@version wins`,
  }));
  return { winner, losers };
}
