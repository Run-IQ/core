import { SpecError, verifyRuleChecksum } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { EngineLimits } from '../limits.js';
import { EngineLimitError } from '../errors/EngineLimitError.js';
import { InputCopier } from '../input/copyInput.js';
import type { RuleValidator } from '../security/RuleValidator.js';
import { compareRuleIdentity } from './resolveTie.js';
import { isObject, ruleLabel } from '../utils/values.js';

// The plugin trust boundary, in one place. The engine owns its state; a plugin is handed views of
// it and never the objects the engine holds; what a plugin returns is read once, bounded, copied
// and checked against a ledger of the rules that were given, before any of it is used.

/**
 * The reasons a plugin may give a skip. They belong to plugins: `PLUGIN` (the plugin's words are
 * in `detail`) and the deprecated values plugins have used (`INHIBITED_BY_META_RULE`,
 * `COUNTRY_MISMATCH`, `MODEL_NOT_FOUND`). The reasons of the engine's own stages are not here: a
 * plugin cannot record a skip as an integrity failure, a dominance or a mismatch of the engine.
 */
export const PLUGIN_SKIP_REASONS: ReadonlySet<string> = new Set([
  'PLUGIN',
  'INHIBITED_BY_META_RULE',
  'COUNTRY_MISMATCH',
  'MODEL_NOT_FOUND',
]);

/**
 * Reads `value` once into data the engine owns: plain objects and lists are copied (keys and
 * length read once) and frozen, a `Date` is copied, and the walk is bounded by
 * `limits.maxInputLeaves` and `limits.maxInputDepth` without recursion (`EngineLimitError`). A
 * property that cannot be read, a hole, a symbol key or a non-enumerable property throws `Error`
 * naming it (`<what>/a could not be read: ...`). Objects that are not plain are kept by
 * reference and never frozen: the caller of this function checks what may remain.
 */
export function readBounded(value: unknown, limits: Readonly<EngineLimits>, what: string): unknown {
  const copier = new InputCopier(limits);
  const copy = copier.copy(value, what);
  if (copier.reasons.length > 0) throw new Error(copier.reasons.join('; '));
  return copy;
}

/**
 * The most leaves one rule (or one skip, which holds a rule) may have. A stated limit of the
 * engine, apart from the ten of `EngineLimits` (D-26 does not list one for rules): a rule is a
 * few dozen leaves, and the cost of reading all of them is bounded by `maxRules` times this.
 */
export const MAX_RULE_LEAVES = 100_000;

/** The limits a single rule is read with: its own leaf bound, the depth of `limits`. */
const ruleLimits = (limits: Readonly<EngineLimits>): Readonly<EngineLimits> => ({
  ...limits,
  maxInputLeaves: MAX_RULE_LEAVES,
});

/**
 * The limits for reading the result an `afterEvaluate` returned: the size of the result it was
 * handed (trusted, so measured, not bounded) plus `maxInputLeaves`, and a few levels more than
 * `maxInputDepth` for the result's own nesting. A hook may grow a result by a bounded amount, not
 * by any amount.
 */
export function resultLimits(
  handed: unknown,
  limits: Readonly<EngineLimits>,
): Readonly<EngineLimits> {
  const measure = new InputCopier({
    ...limits,
    maxInputLeaves: Number.MAX_SAFE_INTEGER,
    maxInputDepth: limits.maxInputDepth + RESULT_DEPTH,
  });
  measure.copy(handed, 'result');
  return {
    ...limits,
    maxInputLeaves: measure.leaves + limits.maxInputLeaves,
    maxInputDepth: limits.maxInputDepth + RESULT_DEPTH,
  };
}

/** Levels a decision adds around the data it holds (trace, steps, rules). */
const RESULT_DEPTH = 16;

/**
 * Reads a list a plugin returned (`rules`, `skipped`): its `length` once, at most `maxRules`
 * items, each item read once and bounded on its own (a list of 100 000 rules is not one tree).
 * Throws `Error` for a value that is not a list or has a hole, `EngineLimitError` past a bound.
 */
export function readItems(value: unknown, limits: Readonly<EngineLimits>, what: string): unknown[] {
  const bounds = ruleLimits(limits);
  if (!Array.isArray(value)) throw new TypeError(`${what} is not a list`);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0)
    throw new TypeError(`${what} has no valid length`);
  if (length > limits.maxRules) throw new EngineLimitError('maxRules', limits.maxRules, length);
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${what} has a hole at index ${index}: lists must be dense`);
    }
    items.push(readBounded(value[index], bounds, `${what}/${index}`));
  }
  return items;
}

/**
 * A fresh, frozen copy of `value`: containers are new and frozen, a `Date` is a new `Date`, and
 * anything else (a non-plain object) is kept as it is and left unfrozen, as it is not the
 * engine's. Recursion is bounded by the depth the data was read with.
 */
export function frozenCopyOf<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => frozenCopyOf(item))) as T;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy: Record<string, unknown> = proto === null ? Object.create(null) : {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: frozenCopyOf(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copy) as T;
}

/** True when the checksum of `rule` is the checksum of its content; false when spec cannot tell. */
function intact(rule: Rule): boolean {
  try {
    return verifyRuleChecksum(rule);
  } catch (error) {
    if (!(error instanceof SpecError)) throw error;
    return false;
  }
}

/** One given rule: the engine's own copy, and the checksum it was verified with. */
interface Entry {
  readonly rule: Rule;
  readonly label: string;
  readonly checksum: string;
}

const pairOf = (label: string, checksum: string): string => `${label}\u0000${checksum}`;

/** What the ledger decided about the rules and skips a hook returned. */
export interface LedgerOutcome {
  /** The rules that go on: the engine's own copies, and the new ones that were validated. */
  readonly rules: readonly Rule[];
  /** The skips, on the engine's own copies, with a plugin reason and a `detail`. */
  readonly skipped: readonly SkippedRule[];
  /** The labels of the rules the hook added, sorted. */
  readonly added: readonly string[];
}

/** What a hook returned, once read and bounded. */
export interface ReturnedRules {
  readonly rules: readonly Rule[];
  readonly skipped: readonly SkippedRule[];
}

/**
 * The rules that take part in an evaluation, held by the engine alone. Every hook is handed a
 * fresh frozen view (`view`); what it returns is checked against the entries the ledger holds,
 * never against anything the hook was able to touch. An entry is a rule instance with its label
 * and the checksum it was verified with; a label that has ever taken part (given, refused at the
 * source, skipped by any stage or plugin) cannot come back with other content.
 */
export class RuleLedger {
  private live: Entry[];
  private readonly everSeen: Set<string>;

  /**
   * @param rules - the source rules that passed validation (the engine's copies).
   * @param seen - the labels of every source rule, valid or not.
   */
  constructor(rules: ReadonlyArray<Rule>, seen: Iterable<string>) {
    this.live = rules.map((rule) => ({
      rule,
      label: ruleLabel(rule),
      checksum: String(rule.checksum),
    }));
    this.everSeen = new Set(seen);
  }

  /** The rules that go on, the engine's own objects (never handed to a plugin). */
  current(): readonly Rule[] {
    return this.live.map((entry) => entry.rule);
  }

  /** A fresh frozen array of fresh frozen copies: what a hook is handed. */
  view(): readonly Rule[] {
    return Object.freeze(this.live.map((entry) => ruleView(entry.rule)));
  }

  /**
   * Checks what a hook returned against the ledger and moves the ledger on, or throws `Error`
   * (the engine turns it into a `PluginHookError`) and leaves the ledger as it was.
   *
   * - A returned rule that matches an unused entry (same label, same checksum, and the checksum
   *   holds for its content) is that entry. Rewritten under the same label, with another
   *   checksum or a content that no longer matches its own, it is refused.
   * - A returned rule whose label has never taken part is an added rule: the full source
   *   validation (`validator`), once.
   * - A returned rule whose label took part and is not live (skipped, refused at the source)
   *   is refused.
   * - A skip names an unused entry (same label and checksum, intact), has the plugin's reason,
   *   and the entry is not also returned.
   * - Each entry is returned or skipped exactly as many times as it was given.
   */
  apply(pluginName: string, returned: ReturnedRules, validator: RuleValidator): LedgerOutcome {
    const fail = (message: string): never => {
      throw new Error(`plugin ${pluginName} ${message}`);
    };

    const byPair = new Map<string, Entry[]>();
    const byLabel = new Set<string>();
    for (const entry of this.live) {
      const pair = pairOf(entry.label, entry.checksum);
      byPair.set(pair, [...(byPair.get(pair) ?? []), entry]);
      byLabel.add(entry.label);
    }
    const givenCount = new Map<string, number>();
    for (const [pair, entries] of byPair) givenCount.set(pair, entries.length);

    // How many times each given entry comes back, rules and skips together.
    const returnedCount = new Map<string, number>();
    const count = (rule: Rule): void => {
      const pair = pairOf(ruleLabel(rule), String(rule.checksum));
      if (givenCount.has(pair)) returnedCount.set(pair, (returnedCount.get(pair) ?? 0) + 1);
    };
    returned.rules.forEach(count);
    returned.skipped.forEach((skip) => count(skip.rule));
    for (const [pair, times] of returnedCount) {
      const given = givenCount.get(pair) as number;
      if (times > given) {
        const label = pair.split('\u0000')[0] as string;
        fail(
          `returned rule ${label} ${times} times (rules and skips together), it was given ${given}`,
        );
      }
    }

    const used = new Set<Entry>();
    const take = (rule: Rule): Entry | undefined => {
      const entries = byPair.get(pairOf(ruleLabel(rule), String(rule.checksum)));
      return entries?.find((entry) => !used.has(entry));
    };

    const kept = new Set<Entry>();
    const added = new Map<string, Rule>();
    for (const rule of returned.rules) {
      const label = ruleLabel(rule);
      const entry = take(rule);
      if (entry !== undefined) {
        if (!intact(rule)) {
          fail(`rewrote rule ${label}: its content is not the one it was given`);
        }
        used.add(entry);
        kept.add(entry);
        continue;
      }
      if (byLabel.has(label)) {
        fail(`rewrote rule ${label}: its content is not the one it was given`);
      }
      if (this.everSeen.has(label)) {
        fail(
          `added rule ${label}, which already took part in this evaluation (skipped or refused)`,
        );
      }
      if (added.has(label)) fail(`added rule ${label} more than once`);
      const [refused] = validator.validate([rule]).invalid;
      if (refused !== undefined) fail(`added rule ${label}: ${refused.detail ?? refused.reason}`);
      added.set(label, rule);
    }

    const skipped: SkippedRule[] = [];
    for (const skip of returned.skipped) {
      const label = ruleLabel(skip.rule);
      if (!byLabel.has(label)) fail(`skipped rule ${label}, which it was not given`);
      const entry = take(skip.rule);
      if (entry === undefined || !intact(skip.rule)) {
        fail(`skipped rule ${label} with a content other than the one it was given`);
      }
      used.add(entry as Entry);
      skipped.push(
        Object.freeze({ rule: (entry as Entry).rule, reason: skip.reason, detail: skip.detail }),
      );
    }

    const lost = this.live.filter((entry) => !used.has(entry)).map((entry) => entry.rule);
    if (lost.length > 0) {
      const names = lost.sort(compareRuleIdentity).map(ruleLabel);
      fail(`removed rules without a skip: ${names.join(', ')}`);
    }

    // Committed only now: every check passed.
    for (const label of added.keys()) this.everSeen.add(label);
    const addedRules = [...added.values()];
    this.live = [
      ...this.live.filter((entry) => kept.has(entry)),
      ...addedRules.map((rule) => ({
        rule,
        label: ruleLabel(rule),
        checksum: String(rule.checksum),
      })),
    ];
    return {
      rules: this.current(),
      skipped,
      added: [...added.keys()].sort(),
    };
  }
}

/** True for a plain object whose own keys are among `allowed`, and that has all of `required`. */
export function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  if (!isObject(value) || typeof value !== 'object' || value === null) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every(
      (key) => typeof key === 'string' && (required.includes(key) || optional.includes(key)),
    ) && required.every((key) => keys.includes(key))
  );
}

/**
 * A fresh frozen copy of a rule for a model or a hook: its own objects and its own `Date`s, so
 * that a write cannot reach the rule the engine holds.
 */
export function ruleView(rule: Rule): Rule {
  return frozenCopyOf(rule);
}
