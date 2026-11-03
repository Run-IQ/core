import { SpecError, verifyRuleChecksum } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { EngineLimits } from '../limits.js';
import { DEFAULT_LIMITS } from '../limits.js';
import type { PPEPlugin } from '../types/plugin.js';
import type { CalculationModel } from '../types/model.js';
import type { DSLEvaluator } from '../types/dsl.js';
import { isRaisedLimit, raiseLimit } from '../errors/EngineLimitError.js';
import { markEngineError } from '../errors/engineError.js';
import { InputCopier } from '../input/copyInput.js';
import type { RuleValidator } from '../security/RuleValidator.js';
import { compareRuleIdentity } from './resolveTie.js';
import { ruleLabel } from '../utils/values.js';
import { isPlainPrototype } from '../utils/plain.js';
import { ViewScope } from './frozenView.js';
import { clip } from '../utils/frozenCopy.js';
import { faultFrom, reading, refusal } from './pluginPort.js';
import { isRaised, raised } from './trust.js';
import { CHARS_PER_NODE, hasLoneSurrogate, serializedLength } from '../utils/weight.js';

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
 * The rule objects one evaluation of one engine holds (a set per evaluation, never shared: an
 * object from another engine or another evaluation is untrusted data, copied and counted). They are deep-frozen, hold no `Date` and no object that is
 * not plain, so nobody can change them: they are handed to hooks as they are, and a hook that
 * returns one of them returns the engine's own object (nothing to copy or to check again).
 */
export type OwnedRules = WeakSet<object>;

/**
 * The refusals a rule was read with (an object inside it that is not plain), by rule: the rule is
 * excluded for them (`INVALID_RULE`), and what stands in the copy is a string, never an object.
 */
const REFUSALS = new WeakMap<object, readonly string[]>();

/** What the rule was refused for when it was read, if anything (`/params/b is not a plain object: Box`). */
export function refusalsOf(rule: object): readonly string[] | undefined {
  return REFUSALS.get(rule);
}

/**
 * A value that could not be read: a property that threw, a hole, a symbol key. `causes` holds what
 * the properties threw, in order, so that the caller can tell a refused write from the plugin's
 * own throw.
 */
export class ReadFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadFailure';
  }
}

/**
 * What the properties of a value threw, by failure. It is kept out of the error (an own property
 * of it would be copied with it): the engine classifies the causes at the site that catches the
 * failure and keeps none of them.
 */
const CAUSES = new WeakMap<object, readonly unknown[]>();
markEngineError(ReadFailure);

/** A failed read, raised by the engine in this call, with what the properties threw. */
function readFailure(message: string, causes: readonly unknown[]): ReadFailure {
  const failure = raised(new ReadFailure(message));
  CAUSES.set(failure, causes);
  return failure;
}

/** True for a failed read the engine raised in this call. */
export function isReadFailure(value: unknown): value is ReadFailure {
  return value instanceof ReadFailure && isRaised(value);
}

/** What the properties threw while the failed value was read, in order (empty if nothing threw). */
export function causesOf(failure: ReadFailure): readonly unknown[] {
  return CAUSES.get(failure) ?? [];
}

/**
 * The exact serialized length of the strings and keys of each rule the engine read: a lower bound
 * of what the record holds for it, known before the record is built.
 */
const RULE_CHARS = new WeakMap<object, number>();

/** The characters a rule read by the engine holds, as the record will write them (a lower bound). */
export function charsOfRule(rule: object): number {
  return RULE_CHARS.get(rule) ?? 0;
}

/**
 * The reader for the code that walks a value a plugin gave by hand (the fields of a hook's result,
 * the items of its lists): the engine's own refusals and limits pass as they are, and whatever else
 * is thrown while a plugin's getter or trap runs inside it is a fault of the plugin, held as text.
 */
export function guarded<T>(fn: () => T): T {
  return reading(() => {
    try {
      return fn();
    } catch (error) {
      // What the engine raised itself in this call passes; anything else, a forged engine error
      // included, is a fault of the plugin whose getter or trap threw it.
      if (isRaised(error)) throw error;
      throw faultFrom(error);
    }
  });
}

/** The leaves read from one list or one return, against one declared limit. */
export class Budget {
  leaves = 0;
  /**
   * The exact serialized length of the text that plugin code handed the engine and that the record
   * is certain to hold (a skip detail, a `meta` or a `pluginState` of `afterEvaluate`): a lower
   * bound of the record, known before it is built.
   */
  recordChars = 0;

  constructor(
    private readonly name: 'maxHookLeaves' | 'maxInputLeaves' | 'maxRuleSetNodes',
    private readonly max: number,
  ) {}

  /** Notes `chars` more characters the record is certain to hold. */
  record(chars: number): void {
    this.recordChars += chars;
  }

  /** The characters read in total, whether or not the record certainly holds them. */
  readChars = 0;

  noteChars(chars: number): void {
    this.readChars += chars;
  }

  /** Counts a text the engine kept from plugin code: its weight, and its place in the record. */
  addText(text: string): void {
    this.add(1 + Math.floor(serializedLength(text) / CHARS_PER_NODE));
    this.record(serializedLength(text));
  }

  /** Counts `count` more leaves; past the limit it throws `EngineLimitError`. */
  add(count: number): void {
    this.leaves += count;
    if (this.leaves > this.max) throw raiseLimit(this.name, this.max, this.leaves);
  }
}

/** How a value is read. */
export interface ReadOptions {
  /** Which limit holds the leaves of this one value (`maxInputLeaves`, or `maxRuleLeaves`). */
  readonly leafLimit?: 'maxInputLeaves' | 'maxRuleLeaves';
  /** The aggregate the leaves of this value also count against. */
  readonly budget?: Budget;
  /**
   * What counts against `budget`: every node (`nodes`, the default), or only the nodes the
   * characters of the text add (`text`) for a value of a fixed small shape whose structure is
   * bounded by its reader (a verdict `{ valid, errors }`).
   */
  readonly budgetMode?: 'nodes' | 'text';
  /** Write every `Date` as its canonical string (a rule holds none). */
  readonly datesAsStrings?: boolean;
  /** A rule is read: an object that is not plain is refused for that rule, not placed as a marker. */
  readonly ruleMode?: boolean;
  /** Allow an `undefined` member (the default refuses it, with its pointer). */
  readonly allowUndefined?: boolean;
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
  return reading(() => readOnce(value, limits, what, options));
}

function readOnce(
  value: unknown,
  limits: Readonly<EngineLimits>,
  what: string,
  options: ReadOptions,
): unknown {
  // A scalar that is not text is one node, read once: no walk to set up (a model answers with a
  // number for most rules).
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'string' && typeof value !== 'function')
  ) {
    options.budget?.add(options.budgetMode === 'text' ? 0 : 1);
    return typeof value === 'number' && Object.is(value, -0) ? 0 : value;
  }
  const copier = new InputCopier(
    limits,
    options.leafLimit ?? 'maxInputLeaves',
    options.datesAsStrings ?? false,
    options.ruleMode ?? false,
    options.allowUndefined !== true,
  );
  try {
    const copy = copier.copy(value, what);
    if (options.ruleMode === true && typeof copy === 'object' && copy !== null) {
      RULE_CHARS.set(copy, copier.chars);
    }
    if (copier.reasons.length > 0) {
      throw readFailure(copier.reasons.join('; '), copier.thrown);
    }
    if (copier.refusals.length > 0) {
      // A rule that is itself not plain is a hard refusal; a member of it excludes the rule.
      if (typeof copy !== 'object' || copy === null)
        throw refusal(copier.refusals[0] ?? 'a value that is not plain data');
      REFUSALS.set(
        copy,
        copier.refusals.map((refusal) =>
          refusal.startsWith(what) ? refusal.slice(what.length) : refusal,
        ),
      );
    }
    return copy;
  } finally {
    options.budget?.add(options.budgetMode === 'text' ? copier.textNodes : copier.leaves);
    options.budget?.noteChars(copier.chars);
  }
}

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
  owned: OwnedRules,
): unknown[] {
  return guarded(() => readList(value, limits, what, budget, owned));
}

function readList(
  value: unknown,
  limits: Readonly<EngineLimits>,
  what: string,
  budget: Budget,
  owned: OwnedRules,
): unknown[] {
  if (!Array.isArray(value)) throw refusal(`${what} is not a list`);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) throw refusal(`${what} has no valid length`);
  if (length > limits.maxRules) throw raiseLimit('maxRules', limits.maxRules, length);
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw refusal(`${what} has a hole at index ${index}: lists must be dense`);
    }
    const item: unknown = value[index];
    if (typeof item === 'object' && item !== null && owned.has(item)) {
      items.push(item);
      continue;
    }
    items.push(
      readBounded(item, limits, `${what}/${index}`, {
        leafLimit: 'maxRuleLeaves',
        budget,
        datesAsStrings: true,
        ruleMode: true,
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
  owned: OwnedRules,
): { rule: unknown; reason: unknown; detail: unknown }[] {
  return guarded(() => readSkipList(value, limits, budget, owned));
}

function readSkipList(
  value: unknown,
  limits: Readonly<EngineLimits>,
  budget: Budget,
  owned: OwnedRules,
): { rule: unknown; reason: unknown; detail: unknown }[] {
  if (!Array.isArray(value)) throw refusal('skipped is not a list');
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) throw refusal('skipped has no valid length');
  if (length > limits.maxRules) throw raiseLimit('maxRules', limits.maxRules, length);
  const skips: { rule: unknown; reason: unknown; detail: unknown }[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw refusal(`skipped has a hole at index ${index}: lists must be dense`);
    }
    const raw: unknown = value[index];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw refusal('a malformed skipped');
    }
    if (!isPlainPrototype(Object.getPrototypeOf(raw))) throw refusal('a malformed skipped');
    const record: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(raw)) {
      if (key !== 'rule' && key !== 'reason' && key !== 'detail') {
        throw refusal('a malformed skipped');
      }
      // Read once, here: a getter answers once and the answer is the one that is checked.
      // justification: `raw` is a plain object (checked above); `key` is one of three names.
      record[key] = (raw as Record<string, unknown>)[key];
    }
    const rule = record['rule'];
    const detailIn = record['detail'];
    // The text crosses with the rest: a string, held to `maxStringLength`, weighed by its exact
    // serialized length against the one budget of the evaluation.
    if (detailIn !== undefined) {
      if (typeof detailIn !== 'string') throw refusal('a malformed skipped');
      readText(detailIn, { limits, budget }, `skipped/${index}/detail`);
    }
    skips.push({
      rule:
        typeof rule === 'object' && rule !== null && owned.has(rule)
          ? rule
          : readBounded(rule, limits, `skipped/${index}/rule`, {
              leafLimit: 'maxRuleLeaves',
              budget,
              datesAsStrings: true,
              ruleMode: true,
            }),
      reason: record['reason'],
      detail: record['detail'],
    });
  }
  return skips;
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
  private readonly owned: OwnedRules;

  /**
   * @param rules - the source rules that passed validation (the engine's copies).
   * @param seen - the labels of every source rule, valid or not.
   */
  constructor(rules: ReadonlyArray<Rule>, seen: Iterable<string>, owned: OwnedRules) {
    this.owned = owned;
    this.live = rules.map((rule) => {
      owned.add(rule);
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
        if (!this.owned.has(rule) && !intact(rule)) {
          fail(`rewrote rule ${label}: its content is not the one it was given`);
        }
        // A copy that holds an object that is not plain, or an invalid `Date`, is read as a string
        // that may equal what was given: it is still not the rule that was given.
        const refusals = refusalsOf(rule);
        if (refusals !== undefined) fail(`returned rule ${label} with ${refusals[0]}`);
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
      if (entry === undefined || (!this.owned.has(skip.rule) && !intact(skip.rule))) {
        fail(`skipped rule ${label} with a content other than the one it was given`);
      }
      const refusals = refusalsOf(skip.rule);
      if (refusals !== undefined) fail(`skipped rule ${label} with ${refusals[0]}`);
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
    for (const rule of addedRules) this.owned.add(rule);
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

/** What the engine reads plugin results with: the limits, and the one budget of the evaluation. */
export interface Crossing {
  readonly limits: Readonly<EngineLimits>;
  readonly budget: Budget;
}

/** A crossing with the default limits and its own budget, for a stage built without the engine's. */
export function defaultCrossing(): Crossing {
  return {
    limits: DEFAULT_LIMITS,
    budget: new Budget('maxHookLeaves', DEFAULT_LIMITS.maxHookLeaves),
  };
}

/** A result a plugin gave that is not the shape its contract names. The engine's own error. */
export class MalformedResult extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedResult';
  }
}
markEngineError(MalformedResult);

/** A malformed result, raised by the engine in this call. */
function malformed(message: string): MalformedResult {
  return raised(new MalformedResult(message));
}

/** True for a malformed result the engine raised in this call. */
export function isMalformed(value: unknown): value is MalformedResult {
  return value instanceof MalformedResult && isRaised(value);
}

/** What the engine took from a `validateParams`. */
export type ParamsVerdict =
  | { readonly kind: 'valid' }
  /** `errors` is the model's error texts, joined and cut to 1 024 characters. */
  | { readonly kind: 'invalid'; readonly errors: string }
  /** The model broke its contract in a way that excludes the rule (`MODEL_ERROR`). */
  | { readonly kind: 'error'; readonly detail: string };

/**
 * Calls `model.validateParams(params)` and takes its result through the one reader: the call and
 * the read are under one `try`; the result is copied once, bounded (`maxRuleLeaves` nodes,
 * `maxStringLength` per text, and the text counts against the budget of the evaluation); and it
 * must be a plain `{ valid: boolean, errors?: string[] }` (`valid` is `true` or `false`, never
 * read by truthiness). A write into the params is a `MODEL_ERROR`; a malformed result is a
 * `MODEL_ERROR` naming what is wrong; a throw of the model's own, in the call or while reading,
 * fails the evaluation as an `UnexpectedEngineError` holding a frozen copy. A limit is an
 * `EngineLimitError`.
 */
export function askValidateParams(
  model: { readonly name: string; validateParams(params: unknown): unknown },
  params: unknown,
  crossing: Crossing,
  foreign: (error: unknown) => Error,
): ParamsVerdict {
  const scope = new ViewScope();
  const what = `validateParams of ${model.name}`;
  let verdict: ParamsVerdict;
  try {
    const raw = model.validateParams(scope.trapped(params));
    // The answer every model gives for almost every rule, `{ valid: true }`, read as the reader
    // reads it (the prototype and the keys once, the property as a data property) without the walk.
    if (reading(() => isPlainValid(raw))) return VALID;
    const result = readBounded(raw, crossing.limits, what, {
      leafLimit: 'maxRuleLeaves',
      budget: crossing.budget,
      budgetMode: 'text',
    });
    verdict = judgeValidation(result, what);
    // The text of what the engine keeps of it (the detail of a skip) is in the record; its weight
    // against the budget was counted when it was read.
    if (verdict.kind === 'invalid') crossing.budget.record(serializedLength(verdict.errors));
  } catch (error) {
    if (isRaisedLimit(error)) {
      // A bound of one result is that rule's fault; the budget of the evaluation is the engine's.
      if (error.limit === 'maxHookLeaves') throw error;
      return errorVerdict(crossing, clip(`${what}: ${error.message}`));
    }
    if (isMalformed(error)) return errorVerdict(crossing, clip(error.message));
    const causes = isReadFailure(error) ? causesOf(error) : [error];
    const written = causes.find((cause) => scope.isWriteError(cause));
    if (written !== undefined) {
      return errorVerdict(crossing, clip((written as Error).message));
    }
    if (isReadFailure(error) && causes.length === 0) {
      return errorVerdict(
        crossing,
        clip(`${what} returned a result that cannot be read: ${error.message}`),
      );
    }
    throw foreign(causes[0] ?? error);
  }
  return verdict;
}

/** A model that broke its contract: the rule is excluded, and the text of the detail is weighed. */
function errorVerdict(crossing: Crossing, detail: string): ParamsVerdict {
  crossing.budget.addText(detail);
  return { kind: 'error', detail };
}

const VALID: ParamsVerdict = Object.freeze({ kind: 'valid' });

/** True for a plain object with exactly the own data property `valid: true`. */
function isPlainValid(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  try {
    if (!isPlainPrototype(Object.getPrototypeOf(raw))) return false;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 1 || keys[0] !== 'valid') return false;
    const descriptor = Reflect.getOwnPropertyDescriptor(raw, 'valid');
    return descriptor !== undefined && descriptor.value === true && descriptor.enumerable === true;
  } catch {
    return false;
  }
}

function judgeValidation(result: unknown, what: string): ParamsVerdict {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw malformed(`${what} returned a result that is not an object`);
  }
  const record = result as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'valid' && key !== 'errors') {
      throw malformed(`${what} returned a result with an unknown key "${key}"`);
    }
  }
  const valid = record['valid'];
  if (valid !== true && valid !== false) {
    throw malformed(`${what} returned a result whose "valid" is not true or false`);
  }
  const errors = record['errors'];
  let texts: string[] = [];
  if (errors !== undefined) {
    if (!Array.isArray(errors) || !errors.every((item) => typeof item === 'string')) {
      throw malformed(`${what} returned "errors" that is not a list of strings`);
    }
    texts = errors as string[];
  }
  if (valid) return { kind: 'valid' };
  return { kind: 'invalid', errors: clip(texts.join('; ')) };
}

/** Reads a verdict a DSL gave (any value, read once, bounded, against the budget). */
export function readVerdict(raw: unknown, crossing: Crossing, what: string): unknown {
  return readBounded(raw, crossing.limits, what, {
    leafLimit: 'maxRuleLeaves',
    budget: crossing.budget,
  });
}

/**
 * Reads the text a plugin gave for a record (a skip's `detail`): a string, held to
 * `maxStringLength`, and weighed against the budget of the evaluation by its exact serialized
 * length.
 */
export function readText(value: unknown, crossing: Crossing, what: string): string {
  if (typeof value !== 'string') throw refusal(`${what} is not a string`);
  const copier = new InputCopier(crossing.limits, 'maxRuleLeaves');
  return reading(() => {
    if (hasLoneSurrogate(value))
      throw refusal(`${what} holds a lone surrogate: not well-formed text`);
    const extra = copier.text(value, () => what);
    crossing.budget.add(1 + extra);
    crossing.budget.record(copier.chars);
    return value;
  });
}

type FunctionKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T] &
  string;

/** Every function a plugin, a model or a DSL evaluator can give the engine to call. */
export type PluginCallback =
  | `PPEPlugin.${FunctionKeys<PPEPlugin>}`
  | `CalculationModel.${FunctionKeys<CalculationModel>}`
  | `DSLEvaluator.${FunctionKeys<DSLEvaluator>}`;

/** One place where something made by plugin code reaches the engine. */
export interface CrossingPoint {
  /** True when the engine calls it; false when it is declared and nothing calls it yet. */
  readonly called: boolean;
  /**
   * `sync`: the contract is synchronous, a promise it returns is a breach (never awaited, its
   * rejection handled). `async`: the engine awaits it, within the time limit of the evaluation,
   * and a rejection is a fault of the plugin. `none`: nothing is called.
   */
  readonly contract: 'sync' | 'async' | 'none';
  /** What comes back from the call and what is thrown, and the reader that takes each. */
  readonly reads: string;
}

/**
 * The inventory of the crossing points: every callback a plugin can give, and how what it returns
 * or throws reaches the engine. A value made by plugin code enters the engine through the one
 * port (`pluginPort.ts`: `reading`, `callSync`, `callAsync`, `faultOf`) and the one reader
 * (`readBounded`, and the `readText` and `askValidateParams` that call it), and through nothing
 * else; a throw is reduced to text (`name`, `message`, `code`) by the port. The hostile-Proxy test
 * (`tests/integration/hostile-proxy.test.ts`) fails if the engine touches plugin data outside the
 * port. The type makes a new callback without an entry a compile error, and
 * `tests/integration/crossing-points.test.ts` runs three probes against each entry that is called
 * (an oversized value, a forged engine error, an `undefined` hidden in a list) and looks for a call
 * of each entry that is not called.
 */
export const CROSSING_POINTS: Readonly<Record<PluginCallback, CrossingPoint>> = {
  'PPEPlugin.onInit': {
    called: true,
    contract: 'sync',
    reads:
      'returns nothing that is read; a throw or a promise becomes a PluginHookError (hook onInit) holding its text',
  },
  'PPEPlugin.beforeEvaluate': {
    called: true,
    contract: 'async',
    reads:
      'readBeforeEvaluate: input, rules, skips (with their detail through readText) and state through readBounded against the one budget; a throw or a rejection becomes a PluginHookError holding its text',
  },
  'PPEPlugin.afterEvaluate': {
    called: true,
    contract: 'async',
    reads:
      'acceptAfterEvaluate: each changed field through readBounded against the one budget of the evaluation (the text of meta and pluginState is also in the record room); a throw or a rejection becomes a PluginHookError holding its text',
  },
  'PPEPlugin.onError': {
    called: true,
    contract: 'sync',
    reads:
      'is handed frozen copies (the error and the engine own input) and returns nothing that is read; a throw or a promise is swallowed, its rejection handled (the evaluation own error reaches the caller)',
  },
  'PPEPlugin.getModels': { called: false, contract: 'none', reads: 'nothing calls it' },
  'PPEPlugin.teardown': { called: false, contract: 'none', reads: 'nothing calls it' },
  'CalculationModel.validateParams': {
    called: true,
    contract: 'sync',
    reads:
      'askValidateParams: the result through readBounded (text against the one budget), a plain { valid: boolean, errors?: string[] }; a throw or a promise becomes an UnexpectedEngineError holding its text',
  },
  'CalculationModel.calculate': {
    called: true,
    contract: 'sync',
    reads:
      'ExecutionPipeline: the output through readBounded against the one budget; a throw or a promise becomes an UnexpectedEngineError holding its text',
  },
  'CalculationModel.describeParams': { called: false, contract: 'none', reads: 'nothing calls it' },
  'CalculationModel.listVariables': {
    called: false,
    contract: 'none',
    reads:
      'the engine never asks a model during evaluate (9M1 does); the exported readsOf can, and reads the answer through readBounded (text against the one budget)',
  },
  'DSLEvaluator.evaluate': {
    called: true,
    contract: 'sync',
    reads:
      'RuleFilter: the verdict through readVerdict (readBounded against the one budget); a throw or a promise is a DSL_ERROR exclusion with a cut message, weighed against the budget',
  },
  'DSLEvaluator.listVariables': {
    called: true,
    contract: 'sync',
    reads:
      'readsOf: the answer through readBounded (text against the one budget); a throw is a problem naming it',
  },
  'DSLEvaluator.compute': { called: false, contract: 'none', reads: 'nothing calls it' },
  'DSLEvaluator.describeSyntax': { called: false, contract: 'none', reads: 'nothing calls it' },
};
