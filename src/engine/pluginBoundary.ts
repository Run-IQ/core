import { SpecError, verifyRuleChecksum } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { EngineLimits } from '../limits.js';
import { EngineLimitError } from '../errors/EngineLimitError.js';
import { InputCopier } from '../input/copyInput.js';
import type { RuleValidator } from '../security/RuleValidator.js';
import { compareRuleIdentity } from './resolveTie.js';
import { ruleLabel } from '../utils/values.js';
import { NotPlain, isDateObject, isPlainPrototype } from '../utils/plain.js';

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
 * The rule objects the engine holds. They are deep-frozen, hold no `Date` and no object that is
 * not plain, so nobody can change them: they are handed to hooks as they are, and a hook that
 * returns one of them returns the engine's own object (nothing to copy or to check again).
 */
const ENGINE_RULES = new WeakSet<object>();

/** The leaves read from one list or one return, against one declared limit. */
export class Budget {
  leaves = 0;

  constructor(
    private readonly name: 'maxHookLeaves' | 'maxInputLeaves',
    private readonly max: number,
  ) {}

  /** Counts `count` more leaves; past the limit it throws `EngineLimitError`. */
  add(count: number): void {
    this.leaves += count;
    if (this.leaves > this.max) throw new EngineLimitError(this.name, this.max, this.leaves);
  }
}

/** How a value is read. */
export interface ReadOptions {
  /** Which limit holds the leaves of this one value (`maxInputLeaves`, or `maxRuleLeaves`). */
  readonly leafLimit?: 'maxInputLeaves' | 'maxRuleLeaves';
  /** The aggregate the leaves of this value also count against. */
  readonly budget?: Budget;
  /** Write every `Date` as its canonical string (a rule holds none). */
  readonly datesAsStrings?: boolean;
}

/**
 * Reads `value` once into data the engine owns: plain objects (those of `@run-iq/spec`, a foreign
 * realm's included) and lists are copied (keys, length and prototype read once) and frozen, a
 * `Date` is copied (or written as a string), and the walk is bounded by the leaf limit,
 * `limits.maxInputDepth` and the aggregate `budget`, without recursion (`EngineLimitError`). A
 * property that cannot be read, a hole, a symbol key or a non-enumerable property throws `Error`
 * naming it (`<what>/a could not be read: ...`). An object that is not plain is replaced by a
 * marker that spec refuses: nothing is ever kept by reference.
 */
export function readBounded(
  value: unknown,
  limits: Readonly<EngineLimits>,
  what: string,
  options: ReadOptions = {},
): unknown {
  const copier = new InputCopier(
    limits,
    options.leafLimit ?? 'maxInputLeaves',
    options.datesAsStrings ?? false,
  );
  try {
    const copy = copier.copy(value, what);
    if (copier.reasons.length > 0) throw new Error(copier.reasons.join('; '));
    return copy;
  } finally {
    options.budget?.add(copier.leaves);
  }
}

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
 * Reads a list (`rules`, `skipped`): its `length` once, at most `maxRules` items, each item read
 * once and bounded on its own by `maxRuleLeaves` and `maxInputDepth`, all of them against the
 * `budget` (a list of 100 000 rules is not one tree, but it is one bound). An item that is one of
 * the engine's own rules is kept as it is. Throws `TypeError` for a value that is not a list or
 * has a hole, `EngineLimitError` past a bound.
 */
export function readItems(
  value: unknown,
  limits: Readonly<EngineLimits>,
  what: string,
  budget: Budget,
): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} is not a list`);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError(`${what} has no valid length`);
  if (length > limits.maxRules) throw new EngineLimitError('maxRules', limits.maxRules, length);
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${what} has a hole at index ${index}: lists must be dense`);
    }
    const item: unknown = value[index];
    if (typeof item === 'object' && item !== null && ENGINE_RULES.has(item)) {
      items.push(item);
      continue;
    }
    items.push(
      readBounded(item, limits, `${what}/${index}`, {
        leafLimit: 'maxRuleLeaves',
        budget,
        datesAsStrings: true,
      }),
    );
  }
  return items;
}

/**
 * Reads the skips a hook returned: a list, each skip a plain record with exactly the keys
 * `rule`, `reason` and `detail` (read once each, by the reader, into a new frozen record; an
 * accessor runs once). Returns the records unchecked as to their values: the caller checks the
 * copy. Throws `TypeError` for a skip that is not such a record.
 */
export function readSkips(
  value: unknown,
  limits: Readonly<EngineLimits>,
  budget: Budget,
): { rule: unknown; reason: unknown; detail: unknown }[] {
  if (!Array.isArray(value)) throw new TypeError('skipped is not a list');
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('skipped has no valid length');
  if (length > limits.maxRules) throw new EngineLimitError('maxRules', limits.maxRules, length);
  const skips: { rule: unknown; reason: unknown; detail: unknown }[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`skipped has a hole at index ${index}: lists must be dense`);
    }
    const raw: unknown = value[index];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError('a malformed skipped');
    }
    if (!isPlainPrototype(Object.getPrototypeOf(raw))) throw new TypeError('a malformed skipped');
    const record: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(raw)) {
      if (key !== 'rule' && key !== 'reason' && key !== 'detail') {
        throw new TypeError('a malformed skipped');
      }
      // Read once, here: a getter answers once and the answer is the one that is checked.
      // justification: `raw` is a plain object (checked above); `key` is one of three names.
      record[key] = (raw as Record<string, unknown>)[key];
    }
    const rule = record['rule'];
    skips.push({
      rule:
        typeof rule === 'object' && rule !== null && ENGINE_RULES.has(rule)
          ? rule
          : readBounded(rule, limits, `skipped/${index}/rule`, {
              leafLimit: 'maxRuleLeaves',
              budget,
              datesAsStrings: true,
            }),
      reason: record['reason'],
      detail: record['detail'],
    });
  }
  return skips;
}

/**
 * A fresh, frozen copy of `value` for a view: containers are new and frozen, a `Date` is a new
 * `Date`, and anything the engine owns (a rule) is returned as it is. Nothing that is not plain is
 * kept: it is replaced by a marker. Recursion is bounded by the depth the data was read with.
 */
// justification: every `as T` below returns a copy of the same shape as the argument.
export function frozenCopyOf<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (ENGINE_RULES.has(value)) return value;
  // justification: `isDateObject` passed, so `getTime` returns a number.
  if (isDateObject(value)) return new Date(Date.prototype.getTime.call(value) as number) as T;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => frozenCopyOf(item))) as T;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (!isPlainPrototype(proto)) return new NotPlain('an object') as T;
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
    this.live = rules.map((rule) => {
      ENGINE_RULES.add(rule);
      return { rule, label: ruleLabel(rule), checksum: String(rule.checksum) };
    });
    this.everSeen = new Set(seen);
  }

  /** The rules that go on, the engine's own objects (never handed to a plugin). */
  current(): readonly Rule[] {
    return this.live.map((entry) => entry.rule);
  }

  /**
   * A fresh frozen array of the engine's own rules: what a hook is handed. The rules are
   * deep-frozen and hold nothing writable, so they are not copied again; only the array is new,
   * because the ledger never reads one back.
   */
  view(): readonly Rule[] {
    return Object.freeze(this.live.map((entry) => entry.rule));
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

    // The common case: the hook handed back exactly the engine's own rules, in order, and skipped
    // none. Every entry is used once, nothing is added, and there is nothing to check.
    if (
      returned.skipped.length === 0 &&
      returned.rules.length === this.live.length &&
      this.live.every((entry, index) => returned.rules[index] === entry.rule)
    ) {
      return { rules: this.current(), skipped: [], added: [] };
    }

    const byPair = new Map<string, Entry[]>();
    const byLabel = new Set<string>();
    for (const entry of this.live) {
      const pair = pairOf(entry.label, entry.checksum);
      const entries = byPair.get(pair);
      if (entries === undefined) byPair.set(pair, [entry]);
      else entries.push(entry);
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
      // justification: `returnedCount` only holds pairs that `givenCount` holds.
      const given = givenCount.get(pair) as number;
      if (times > given) {
        // justification: a pair is `label`, a separator and a checksum: `split` has two parts.
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
        // The engine's own object is frozen and cannot have changed; a copy is checked.
        if (!ENGINE_RULES.has(rule) && !intact(rule)) {
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
      // A model registered after the evaluation began is not one the rules were validated against.
      if (!validator.knowsModel(rule)) {
        fail(`added rule ${label}, whose model ${String(rule.model)} is not registered`);
      }
      const [refused] = validator.validate([rule]).invalid;
      if (refused !== undefined) fail(`added rule ${label}: ${refused.detail ?? refused.reason}`);
      added.set(label, rule);
    }

    const skipped: SkippedRule[] = [];
    for (const skip of returned.skipped) {
      const label = ruleLabel(skip.rule);
      if (!byLabel.has(label)) fail(`skipped rule ${label}, which it was not given`);
      const entry = take(skip.rule);
      if (entry === undefined || (!ENGINE_RULES.has(skip.rule) && !intact(skip.rule))) {
        fail(`skipped rule ${label} with a content other than the one it was given`);
      }
      // justification: the `if` above throws when `entry` is `undefined`.
      used.add(entry as Entry);
      skipped.push(
        Object.freeze({
          rule: (entry as Entry).rule,
          reason: skip.reason,
          // The plugin's name is always in the record, prefixed by the engine.
          detail: `plugin ${pluginName}: ${skip.detail ?? 'skipped'}`,
        }),
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
    for (const rule of addedRules) ENGINE_RULES.add(rule);
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
