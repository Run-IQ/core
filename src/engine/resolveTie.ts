import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import { RuleConflictError } from '../errors/RuleConflictError.js';

/**
 * Resolves a tie between rules that share the same priority.
 * 'throw' raises a RuleConflictError naming every tied rule; 'first' keeps the smallest id
 * (code-unit order) and skips the others with RULE_CONFLICT.
 */
export function resolveTie(
  rules: readonly Rule[],
  mode: 'throw' | 'first',
): { winner: Rule; losers: SkippedRule[] } {
  const [head] = rules;
  if (head === undefined) {
    throw new Error('resolveTie requires at least one rule');
  }
  if (mode === 'throw' && rules.length > 1) {
    throw new RuleConflictError(
      rules.map((r) => r.id),
      head.priority,
    );
  }
  const sorted = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const [winner, ...others] = sorted;
  if (winner === undefined) {
    throw new Error('resolveTie requires at least one rule');
  }
  const losers: SkippedRule[] = others.map((rule) => ({
    rule,
    reason: 'RULE_CONFLICT',
    detail: `tied with ${winner.id}@${winner.version} at priority ${winner.priority}; the smallest id wins`,
  }));
  return { winner, losers };
}
