import type { JsonValue } from '@run-iq/spec';
import { EngineLimitError } from '../errors/EngineLimitError.js';
import type { EngineLimits } from '../limits.js';
import type { BeforeEvaluateResult } from '../types/plugin.js';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import { describeValue, findNonJson } from '../utils/json.js';
import { copyData, isObject } from '../utils/values.js';

/** What the engine takes from a `beforeEvaluate` result, read once and checked. */
export interface BeforeEvaluateReading {
  /**
   * The input as the hook returned it, read once and not copied here: the engine copies it, bounds
   * it and checks it (`InputSanitizer.prepare`), which reads each member once.
   */
  readonly input: unknown;
  readonly rules: readonly Rule[];
  /** The plugin's skips, each with a `detail` (`skipped by plugin <name>` when it gave none). */
  readonly skipped: readonly SkippedRule[];
  /** The JSON state to keep, when the plugin returned one. */
  readonly state?: JsonValue | undefined;
}

/**
 * Reads what a plugin's `beforeEvaluate` returned, once: `input`, `rules`, `skipped` and `state`
 * are read by name, once each (an own, non-enumerable or inherited getter runs a single time);
 * `rules`, `skipped` and `state` are copied (`copyData`) before any check, and the engine uses
 * only that copy.
 *
 * Throws `TypeError` (`plugin <name> beforeEvaluate returned ...`) when the result is not an
 * object, when `input` is not an object, when `rules` is not an array of objects, when `skipped`
 * is neither absent nor an array of `{ rule: object, reason: string, detail?: string }`, or when
 * `state` is not JSON (`a state that is not JSON at $.a[1] (Date)`); a getter that throws while
 * the result is read throws too. Throws `EngineLimitError` (`maxRules`) when `rules` holds more
 * rules than `limits.maxRules`, before they are copied. The engine then fails the evaluation
 * (`PluginHookError`): nothing of the result is used.
 */
export function readBeforeEvaluate(
  pluginName: string,
  returned: BeforeEvaluateResult,
  limits: Readonly<EngineLimits>,
): BeforeEvaluateReading {
  const refuse = (what: string): TypeError =>
    new TypeError(`plugin ${pluginName} beforeEvaluate returned ${what}`);
  const raw: unknown = returned;
  if (!isObject(raw)) throw refuse(`${describeValue(raw)}, not a result`);
  // Read by name, once each (own, non-enumerable or inherited getters alike).
  const input: unknown = returned.input;
  const rulesIn: unknown = returned.rules;
  const skippedIn: unknown = returned.skipped;
  const stateIn: unknown = returned.state;

  if (!isObject(input)) throw refuse('a malformed input');

  if (!Array.isArray(rulesIn)) throw refuse('a malformed rules');
  if (rulesIn.length > limits.maxRules) {
    throw new EngineLimitError('maxRules', limits.maxRules, rulesIn.length);
  }
  const rules = copyData(rulesIn) as unknown[];
  if (!rules.every(isObject)) throw refuse('a malformed rules');

  const skipped = copyData(skippedIn ?? []);
  if (!Array.isArray(skipped) || !skipped.every(isSkip)) throw refuse('a malformed skipped');

  const state = copyData(stateIn) as JsonValue | undefined;
  const stateNotJson = state === undefined ? undefined : findNonJson(state);
  if (stateNotJson !== undefined) throw refuse(`a state that is not JSON at ${stateNotJson}`);
  return {
    input,
    rules: rules as Rule[],
    skipped: skipped.map((skip) => withDetail(skip, pluginName)),
    state,
  };
}

/** True for `{ rule: object, reason: string, detail?: string }`. */
export function isSkip(value: unknown): boolean {
  if (!isObject(value) || typeof value !== 'object' || value === null) return false;
  const detail: unknown = Reflect.get(value, 'detail');
  return (
    isObject(Reflect.get(value, 'rule')) &&
    typeof Reflect.get(value, 'reason') === 'string' &&
    (detail === undefined || typeof detail === 'string')
  );
}

/** The skip, with `detail: 'skipped by plugin <name>'` when it has none. */
export function withDetail(skip: SkippedRule, pluginName: string): SkippedRule {
  return skip.detail === undefined ? { ...skip, detail: `skipped by plugin ${pluginName}` } : skip;
}
