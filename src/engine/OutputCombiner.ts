import { canonicalize } from '@run-iq/spec';
import type { JsonValue, OutputDeclaration, OutputRounding } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { DecisionOutput } from '../types/output.js';
import { OutputNotFiniteError } from '../errors/OutputNotFiniteError.js';
import { DecimalPrecisionError } from '../errors/DecimalPrecisionError.js';
import { describeValue } from '../utils/json.js';
import { ruleLabel } from '../utils/values.js';
import { compareByPriorityThenIdentity, compareRuleIdentity, resolveTie } from './resolveTie.js';
import { describeMismatch, readOutputValue } from './outputDeclaration.js';
import {
  DECIMAL_DIGITS_LIMIT,
  compareNumeric,
  decimalText,
  exactSum,
  floatSum,
  isNumeric,
  numberOf,
  round,
  roundDecimal,
  roundNumber,
  significantDigits,
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

/** The rounding of each contribution, and that of the combined value, a declaration asks for. */
function roundingsOf(declaration: OutputDeclaration): {
  perContribution: OutputRounding | undefined;
  atOutput: OutputRounding | undefined;
} {
  const { rounding } = declaration;
  return rounding?.at === 'contribution'
    ? { perContribution: rounding, atOutput: undefined }
    : { perContribution: undefined, atOutput: rounding };
}

/**
 * Throws `DecimalPrecisionError` when `value`, a decimal of output `name`, has more than
 * `DECIMAL_DIGITS_LIMIT` significant digits; returns it otherwise.
 */
function heldToLimit(name: string, declaration: OutputDeclaration, value: JsonValue): JsonValue {
  if (declaration.type !== 'decimal' || typeof value !== 'string') return value;
  if (significantDigits(value) > DECIMAL_DIGITS_LIMIT) {
    throw new DecimalPrecisionError(name, DECIMAL_DIGITS_LIMIT);
  }
  return value;
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

/**
 * How a value read for output `name` enters it: rounded by `perContribution` if any, with
 * `unrounded` when that changed it. Both values are held to the decimal limit.
 */
function enter(
  name: string,
  declaration: OutputDeclaration,
  read: JsonValue,
  perContribution: OutputRounding | undefined,
): RecordedContribution {
  heldToLimit(name, declaration, read);
  if (perContribution === undefined) return { value: read };
  const value = heldToLimit(name, declaration, roundValue(read, declaration, perContribution));
  return value === read ? { value } : { value, unrounded: read };
}

/** The value `keepRight` prefers among numbers or decimals, compared exactly; the first on a tie. */
function extreme(values: readonly Numeric[], keepRight: (cmp: number) => boolean): Numeric {
  return values.reduce((best, value) => (keepRight(compareNumeric(value, best)) ? value : best));
}

/**
 * The combined value of output `name`, rounded by `atOutput` if any; the value before and after
 * rounding are held to the decimal limit. Values other than numbers and decimals are unchanged.
 */
function finish(
  name: string,
  declaration: OutputDeclaration,
  value: JsonValue,
  atOutput: OutputRounding | undefined,
): JsonValue {
  heldToLimit(name, declaration, value);
  if (atOutput === undefined) return value;
  return heldToLimit(name, declaration, roundValue(value, declaration, atOutput));
}

/** The items of the lists, in order, keeping the first of those with the same canonical form. */
function unionOf(lists: readonly JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  const items: JsonValue[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue; // excluded beforehand by readOutputValue
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
   * - `sum`, `max`, `min` compare and add in `Decimal`. A `decimal` sum is exact. A
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
   * Every decimal handled here (each contribution, before and after its rounding, and the
   * combined value, before and after its rounding) is held to 1000 significant digits: beyond,
   * `DecimalPrecisionError` is thrown rather than the decision returned with a rounded amount.
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
    const { perContribution, atOutput } = roundingsOf(declaration);
    const skipped: SkippedRule[] = [];
    const valid: Contribution[] = [];
    const recorded = new Map<Rule, RecordedContribution>();
    for (const contribution of [...contributions].sort(byPriorityThenIdentity)) {
      const { rule } = contribution;
      const read = readOutputValue(contribution.value, declaration);
      if (read === undefined) {
        skipped.push({
          rule,
          reason: 'OUTPUT_MISMATCH',
          detail: `output ${name}: ${describeMismatch(contribution.value, declaration)}`,
        });
        continue;
      }
      const entered = enter(name, declaration, read, perContribution);
      valid.push({ rule, value: entered.value });
      recorded.set(rule, entered);
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
          value = decimalText(exactSum(numeric.map(String)));
          break;
        }
        // A number is rounded in Decimal, before it becomes a number.
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
    const roundedSum = declaration.combine === 'sum' && declaration.type === 'number';
    value = finish(name, declaration, value, roundedSum ? undefined : atOutput);

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

  /**
   * The output a `shortCircuit` imposes `imposed` on, with its carrier `rule` as only
   * contributor, and the value its step records. The value is read as a contribution would be
   * (canonical for a `decimal`), then the declared rounding applies: at `contribution`, to it as
   * the only contribution (`recorded.unrounded` when that changed it); otherwise to the output.
   * Throws `DecimalPrecisionError` for a decimal beyond 1000 significant digits, and an `Error`
   * for a value the declaration refuses (`ExceptionProcessor` excludes such a carrier first).
   */
  impose(
    name: string,
    declaration: OutputDeclaration,
    rule: Rule,
    imposed: JsonValue,
  ): { output: DecisionOutput; recorded: RecordedContribution } {
    const read = readOutputValue(imposed, declaration);
    if (read === undefined) {
      throw new Error(
        `short-circuit of ${ruleLabel(rule)} on output ${name}: ${describeMismatch(imposed, declaration)}`,
      );
    }
    const { perContribution, atOutput } = roundingsOf(declaration);
    const recorded = enter(name, declaration, read, perContribution);
    return {
      output: {
        name,
        type: declaration.type,
        combine: declaration.combine,
        value: finish(name, declaration, recorded.value, atOutput),
        contributors: [rule.id],
      },
      recorded,
    };
  },
};
