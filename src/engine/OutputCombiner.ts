import Decimal from 'decimal.js';
import { canonicalize, valueMatchesOutputType } from '@run-iq/spec';
import type { JsonValue, OutputDeclaration } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { DecisionOutput } from '../types/output.js';
import { compareRuleIdentity, resolveTie } from './resolveTie.js';
import { describeType } from './outputDeclaration.js';

/** What a rule computed for an output. */
export interface Contribution {
  readonly rule: Rule;
  readonly value: JsonValue;
}

const byPriorityThenIdentity = (a: { rule: Rule }, b: { rule: Rule }): number =>
  b.rule.priority - a.rule.priority || compareRuleIdentity(a.rule, b.rule);

/** The ids of the rules, in order, each once. */
const idsOf = (contributions: readonly Contribution[]): string[] => [
  ...new Set(contributions.map((c) => c.rule.id)),
];

const decimalOf = (value: JsonValue): Decimal => new Decimal(String(value));

/** The value `keepRight` prefers among numbers, compared exactly in `Decimal`; the first on a tie. */
function extreme(values: readonly JsonValue[], keepRight: (cmp: number) => boolean): JsonValue {
  return values.reduce((best, value) =>
    keepRight(decimalOf(value).comparedTo(decimalOf(best))) ? value : best,
  );
}

/** The items of the lists, in order, keeping the first of those with the same canonical form. */
function unionOf(lists: readonly JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  const items: JsonValue[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue; // excluded beforehand by valueMatchesOutputType
    for (const item of list) {
      const key = canonicalize(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items;
}

export const OutputCombiner = {
  /**
   * Combines the contributions of the rules feeding one output, as `declaration` says.
   *
   * A contribution whose value does not match the declared type is excluded with
   * `OUTPUT_MISMATCH`. With the remaining ones, in order of priority descending then id@version:
   * - `sum`, `max`, `min` compute in `Decimal`, so `0.1 + 0.2` is `0.3`;
   * - `all` and `any` are the logical AND and OR;
   * - `union` concatenates the lists and keeps the first of the items with the same canonical
   *   form;
   * - `highestPriority` takes the value of the highest priority. Rules of that priority whose
   *   values differ canonically are a tie: `resolveTie` throws in `throw` mode, and in `first`
   *   mode keeps the lowest id@version and the rules that agree with it, the others being
   *   skipped with `RULE_CONFLICT`. The lower priorities do not contribute.
   *
   * `contributors` lists, in that order, the ids of the rules whose contribution entered the
   * value. `output` is `undefined` when no contribution remains.
   */
  combine(
    name: string,
    declaration: OutputDeclaration,
    contributions: readonly Contribution[],
    mode: 'throw' | 'first',
  ): { output: DecisionOutput | undefined; skipped: SkippedRule[] } {
    const skipped: SkippedRule[] = [];
    const valid: Contribution[] = [];
    for (const contribution of [...contributions].sort(byPriorityThenIdentity)) {
      if (valueMatchesOutputType(contribution.value, declaration)) {
        valid.push(contribution);
      } else {
        skipped.push({
          rule: contribution.rule,
          reason: 'OUTPUT_MISMATCH',
          detail: `output ${name}: value ${canonicalize(contribution.value)} does not match type ${describeType(declaration)}`,
        });
      }
    }
    const head = valid[0];
    if (head === undefined) return { output: undefined, skipped };

    const values = valid.map((c) => c.value);
    let value: JsonValue;
    let contributors: readonly Contribution[] = valid;
    switch (declaration.combine) {
      case 'sum':
        value = values
          .reduce<Decimal>((total, v) => total.plus(decimalOf(v)), new Decimal(0))
          .toNumber();
        break;
      case 'max':
        value = extreme(values, (cmp) => cmp > 0);
        break;
      case 'min':
        value = extreme(values, (cmp) => cmp < 0);
        break;
      case 'all':
        value = values.every((v) => v === true);
        break;
      case 'any':
        value = values.some((v) => v === true);
        break;
      case 'union':
        value = unionOf(values);
        break;
      case 'highestPriority': {
        const top = valid.filter((c) => c.rule.priority === head.rule.priority);
        const keys = new Map(top.map((c) => [c.rule, canonicalize(c.value)]));
        if (new Set(keys.values()).size === 1) {
          contributors = top;
        } else {
          const tie = resolveTie(
            top.map((c) => c.rule),
            mode,
          );
          const kept = keys.get(tie.winner);
          contributors = top.filter((c) => keys.get(c.rule) === kept);
          for (const loser of tie.losers) {
            if (keys.get(loser.rule) === kept) continue;
            skipped.push({ ...loser, detail: `output ${name}: ${loser.detail}` });
          }
        }
        // Never empty: the head, or the tie's winner, which leads (contributions are in
        // identity order within a priority).
        value = (contributors[0] ?? head).value;
        break;
      }
    }

    skipped.sort((a, b) => byPriorityThenIdentity(a, b));
    return {
      output: {
        name,
        type: declaration.type,
        combine: declaration.combine,
        value,
        contributors: idsOf(contributors),
      },
      skipped,
    };
  },
};
