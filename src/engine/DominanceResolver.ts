import type { Rule } from '../types/rule.js';
import { RuleConflictError } from '../errors/RuleConflictError.js';

export class DominanceResolver {
  resolve(rules: ReadonlyArray<Rule>, mode: 'throw' | 'first'): readonly Rule[] {
    if (rules.length <= 1) {
      return rules;
    }

    // Sort by priority descending
    const sorted = [...rules].sort((a, b) => b.priority - a.priority);

    // Detect conflicts: same priority
    const priorityGroups = new Map<number, Rule[]>();
    for (const rule of sorted) {
      const group = priorityGroups.get(rule.priority);
      if (group) {
        group.push(rule);
      } else {
        priorityGroups.set(rule.priority, [rule]);
      }
    }

    for (const [priority, group] of priorityGroups) {
      if (group.length > 1) {
        if (mode === 'throw') {
          throw new RuleConflictError(
            group.map((r) => r.id),
            priority,
          );
        }
        // mode 'first': keep only the first rule in each conflict group
      }
    }

    if (mode === 'first') {
      // Deduplicate by priority: keep first occurrence per priority
      const seen = new Set<number>();
      const deduped: Rule[] = [];
      for (const rule of sorted) {
        if (!seen.has(rule.priority)) {
          seen.add(rule.priority);
          deduped.push(rule);
        } else {
          // Check if this priority has conflicts
          const group = priorityGroups.get(rule.priority);
          if (group && group.length > 1) {
            // Already added the first one, skip duplicates
            continue;
          }
          deduped.push(rule);
        }
      }
      return deduped;
    }

    return sorted;
  }
}
