import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import { resolveTie } from './resolveTie.js';

const byPriorityThenId = (a: Rule, b: Rule): number =>
  b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class DominanceResolver {
  /**
   * Within a dominanceGroup only the highest priority applies; the others are DOMINATED.
   * A tie at the top of a group is a conflict (see resolveTie). Rules without a group are never
   * dominated and never in conflict. Kept rules are ordered by priority descending, then id.
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

    for (const [group, members] of groups) {
      const top = Math.max(...members.map((r) => r.priority));
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

    kept.sort(byPriorityThenId);
    return { kept, skipped };
  }
}
