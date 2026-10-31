import { canonicalize, valueMatchesOutputType } from '@run-iq/spec';
import type { JsonValue, OutputDeclaration, OutputRounding } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { DecisionOutput } from '../types/output.js';
import { OutputNotFiniteError } from '../errors/OutputNotFiniteError.js';
import { DecimalPrecisionError } from '../errors/DecimalPrecisionError.js';
import { describeValue } from '../utils/json.js';
import { compareByPriorityThenIdentity, compareRuleIdentity, resolveTie } from './resolveTie.js';
import { describeType } from './outputDeclaration.js';
import {
  DECIMAL_DIGITS_LIMIT,
  compareNumeric,
  decimalText,
  exactSum,
  floatSum,
  isNumeric,
  numberOf,
  readDecimal,
  round,
  roundDecimal,
  roundNumber,
} from './decimalArithmetic.js';
import type { Numeric } from './decimalArithmetic.js';

/** What a rule computed for an output. */
export interface Contribution {
  readonly rule: Rule;
  readonly value: JsonValue;
}

/**
 * The value a rule's contribution entered the output with, as its trace step records it: in
 * canonical form for a `decimal` output, rounded under `rounding.at: 'contribution'`.
 * `unrounded` is the value before rounding, present only when rounding changed it.
 */
export interface RecordedContribution {
  readonly value: JsonValue;
  readonly unrounded?: JsonValue;
}

const byPriorityThenIdentity = (a: { rule: Rule }, b: { rule: Rule }): number =>
  compareByPriorityThenIdentity(a.rule, b.rule);

/** The ids of the rules, in order, each once. */
const idsOf = (contributions: readonly Contribution[]): string[] => [
  ...new Set(contributions.map((c) => c.rule.id)),
];

/** What a `decimal` contribution may be, for messages. */
const DECIMAL_EXPECTED =
  'expected a decimal string (an optional "-", digits, an optional "." and digits, no exponent) ' +
  'or a safe integer';

/**
 * The value a contribution enters with, before any rounding: the canonical decimal of a
 * `decimal` output (`readDecimal`), the value itself for another type when it matches it;
 * `undefined` when it does not.
 */
function readValue(value: JsonValue, declaration: OutputDeclaration): JsonValue | undefined {
  if (declaration.type === 'decimal') return readDecimal(value);
  return valueMatchesOutputType(value, declaration) ? value : undefined;
}

/**
 * A number, or the decimal of a `decimal` output, rounded as `rounding` says. Other values are
 * returned as they are: registration allows a rounding on `number` and `decimal` outputs only.
 */
function roundValue(
  value: JsonValue,
  declaration: OutputDeclaration,
  rounding: OutputRounding,
): JsonValue {
  if (typeof value === 'number') return roundNumber(value, rounding);
  if (typeof value === 'string' && declaration.type === 'decimal') {
    return roundDecimal(value, rounding);
  }
  return value;
}

/** The value `keepRight` prefers among numbers or decimals, compared exactly; the first on a tie. */
function extreme(values: readonly Numeric[], keepRight: (cmp: number) => boolean): Numeric {
  return values.reduce((best, value) => (keepRight(compareNumeric(value, best)) ? value : best));
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
   * Precondition: the values are JSON (the pipeline checks it). A value reaching here that is not
   * (`NaN`, `Infinity`) is still described without throwing.
   *
   * A contribution whose value does not match the declared type is excluded with
   * `OUTPUT_MISMATCH`. A `decimal` contribution is a decimal string or a safe integer, taken in
   * canonical form (`"0012.50"` is `"12.5"`); a float, an exponent or text is excluded. Under
   * `rounding.at: 'contribution'`, each remaining contribution is rounded before combining.
   * With the remaining ones, in order of priority descending then id@version:
   * - `sum`, `max`, `min` compare and add in `Decimal`. A `decimal` sum is exact; one with more
   *   than 1000 significant digits throws `DecimalPrecisionError` rather than being rounded. A
   *   `number` sum keeps 20 significant digits (`0.1 + 0.2` is `0.3`), and one that is not a
   *   finite number (overflow) throws `OutputNotFiniteError`: no decision is returned with a
   *   partial amount;
   * - `all` and `any` are the logical AND and OR;
   * - `union` concatenates the lists and keeps the first of the items with the same canonical
   *   form;
   * - `highestPriority` takes the value of the highest priority. Rules of that priority whose
   *   values differ canonically are a tie: `resolveTie` throws in `throw` mode, and in `first`
   *   mode keeps the lowest id@version and the rules that agree with it, the others being
   *   skipped with `RULE_CONFLICT`. The lower priorities do not contribute.
   *
   * Under `rounding` with `at` absent or `'output'`, the combined value of `sum`, `max`, `min`
   * or `highestPriority` is rounded; a `number` is rounded in `Decimal`, then converted.
   *
   * `contributors` lists, in that order, the ids of the rules whose contribution entered the
   * value. `output` is `undefined` when no contribution remains (never `null`). `recorded` gives,
   * for each rule not skipped, the value its trace step records (`RecordedContribution`).
   */
  combine(
    name: string,
    declaration: OutputDeclaration,
    contributions: readonly Contribution[],
    mode: 'throw' | 'first',
  ): {
    output: DecisionOutput | undefined;
    skipped: SkippedRule[];
    recorded: Map<Rule, RecordedContribution>;
  } {
    const { rounding } = declaration;
    const perContribution = rounding?.at === 'contribution' ? rounding : undefined;
    const atOutput =
      rounding !== undefined && rounding.at !== 'contribution' ? rounding : undefined;
    const skipped: SkippedRule[] = [];
    const valid: Contribution[] = [];
    const recorded = new Map<Rule, RecordedContribution>();
    for (const contribution of [...contributions].sort(byPriorityThenIdentity)) {
      const { rule } = contribution;
      const read = readValue(contribution.value, declaration);
      if (read === undefined) {
        const expected = declaration.type === 'decimal' ? `: ${DECIMAL_EXPECTED}` : '';
        skipped.push({
          rule,
          reason: 'OUTPUT_MISMATCH',
          detail: `output ${name}: value ${describeValue(contribution.value)} does not match type ${describeType(declaration)}${expected}`,
        });
        continue;
      }
      const value =
        perContribution === undefined ? read : roundValue(read, declaration, perContribution);
      valid.push({ rule, value });
      recorded.set(rule, value === read ? { value } : { value, unrounded: read });
    }
    const head = valid[0];
    if (head === undefined) return { output: undefined, skipped, recorded };

    const values = valid.map((c) => c.value);
    const numeric = values.filter(isNumeric); // all of them for sum, max and min (readValue)
    let value: JsonValue;
    let contributors: readonly Contribution[] = valid;
    switch (declaration.combine) {
      case 'sum': {
        if (declaration.type === 'decimal') {
          const sum = exactSum(numeric.map(String));
          if (sum === undefined) throw new DecimalPrecisionError(name, DECIMAL_DIGITS_LIMIT);
          value = decimalText(atOutput === undefined ? sum : round(sum, atOutput));
          break;
        }
        const sum = floatSum(numeric.filter((v): v is number => typeof v === 'number'));
        const total = numberOf(atOutput === undefined ? sum : round(sum, atOutput));
        if (!Number.isFinite(total)) {
          const ids = [...valid].sort((a, b) => compareRuleIdentity(a.rule, b.rule));
          throw new OutputNotFiniteError(name, idsOf(ids));
        }
        value = total;
        break;
      }
      case 'max':
        value = extreme(numeric, (cmp) => cmp > 0);
        break;
      case 'min':
        value = extreme(numeric, (cmp) => cmp < 0);
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
      default: {
        const unknown: never = declaration.combine;
        throw new Error(`Unknown combine strategy ${describeValue(unknown)} for output ${name}`);
      }
    }
    // The sum rounded its total already; all, any and union hold no number.
    if (atOutput !== undefined && declaration.combine !== 'sum') {
      value = roundValue(value, declaration, atOutput);
    }

    for (const { rule } of skipped) recorded.delete(rule);
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
      recorded,
    };
  },
};
