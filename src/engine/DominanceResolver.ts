import type { Rule } from '../types/rule.js';
import { RuleConflictError } from '../errors/RuleConflictError.js';

export class DominanceResolver {
  /**
   * Resolves rule order and detects conflicts.
   * A conflict occurs when multiple rules share the same Priority AND the same DominanceGroup.
   * If a rule has no dominanceGroup, its ID is used as a fallback to prevent accidental conflicts.
   */
  resolve(rules: ReadonlyArray<Rule>, mode: 'throw' | 'first'): readonly Rule[] {
    if (rules.length <= 1) {
      return rules;
    }

    // Sort by priority descending (highest first)
    const sorted = [...rules].sort((a, b) => b.priority - a.priority);

    // Group rules by Priority + DominanceGroup
    const groups = new Map<string, Rule[]>();
    for (const rule of sorted) {
      const groupKey = `${rule.priority}_${rule.dominanceGroup ?? rule.id}`;
      const group = groups.get(groupKey) ?? [];
      group.push(rule);
      groups.set(groupKey, group);
    }

    const finalRules: Rule[] = [];

    for (const [, group] of groups) {
      const first = group[0];
      if (!first) continue;
      if (group.length > 1) {
        if (mode === 'throw') {
          throw new RuleConflictError(
            group.map((r) => r.id),
            first.priority,
          );
        }
        // mode 'first': keep only the first one in this specific group
        finalRules.push(first);
      } else {
        finalRules.push(first);
      }
    }

    // Re-sort final rules by priority descending
    return finalRules.sort((a, b) => b.priority - a.priority);
  }
}
