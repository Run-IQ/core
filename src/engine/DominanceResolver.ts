import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import { compareByPriorityThenIdentity, resolveTie } from './resolveTie.js';

export class DominanceResolver {
  /**
   * Within a dominanceGroup only the highest priority applies; the others are DOMINATED.
   * A tie at the top of a group is a conflict (see resolveTie). Rules without a group are never
   * dominated and never in conflict. Kept rules are ordered by priority descending, then id@version.
   */
  resolve(
    rules: ReadonlyArray<Rule>,
    mode: 'throw' | 'first',
  ): { kept: Rule[]; skipped: SkippedRule[] } {
    const kept: Rule[] = [];
    const skipped: SkippedRule[] = [];
    const groups = new Map<string, Rule[]>();

    for (const rule of rules) {
      if (rule.dominanceGroup === undefined) {
        kept.push(rule);
        continue;
      }
      const members = groups.get(rule.dominanceGroup) ?? [];
      members.push(rule);
      groups.set(rule.dominanceGroup, members);
    }

    const groupNames = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const group of groupNames) {
      const members = groups.get(group) ?? [];
      const top = members.reduce((max, r) => Math.max(max, r.priority), -Infinity);
      const head = members.filter((r) => r.priority === top);
      const tie = resolveTie(head, mode);
      const winner = tie.winner;
      skipped.push(...tie.losers);
      kept.push(winner);
      for (const rule of members) {
        if (rule.priority < top) {
          skipped.push({
            rule,
            reason: 'DOMINATED',
            detail: `dominated by ${winner.id}@${winner.version} (priority ${winner.priority}) in group ${group}`,
          });
        }
      }
    }

    kept.sort(compareByPriorityThenIdentity);
    skipped.sort((a, b) => compareByPriorityThenIdentity(a.rule, b.rule));
    return { kept, skipped };
  }
}
