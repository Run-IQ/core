import type { JsonValue } from '@run-iq/spec';
import type { EvaluationInput } from '../types/input.js';
import type { BeforeEvaluateResult } from '../types/plugin.js';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import { describeValue, findNonJson } from '../utils/json.js';
import { copyData, isObject } from '../utils/values.js';

/** What the engine takes from a `beforeEvaluate` result, read once and checked. */
export interface BeforeEvaluateReading {
  readonly input: EvaluationInput;
  readonly rules: readonly Rule[];
  /** The plugin's skips, each with a `detail` (`skipped by plugin <name>` when it gave none). */
  readonly skipped: readonly SkippedRule[];
  /** The JSON state to keep, when the plugin returned one. */
  readonly state?: JsonValue | undefined;
}

/**
 * Reads what a plugin's `beforeEvaluate` returned, once: `input`, `rules`, `skipped` and `state`
 * are read by name, once each (an own, non-enumerable or inherited getter runs a single time),
 * and copied (`copyData`) before any check; the engine uses only that copy.
 *
 * Throws `TypeError` (`plugin <name> beforeEvaluate returned ...`) when the result is not an
 * object, when `input` is not an object with object `data` and `meta`, when `rules` is not an
 * array of objects, when `skipped` is neither absent nor an array of
 * `{ rule: object, reason: string, detail?: string }`, or when `state` is not JSON (`a state that
 * is not JSON at $.a[1] (Date)`); a getter that throws while the result is read throws too. The
 * engine then fails the evaluation (`PluginHookError`): nothing of the result is used.
 */
export function readBeforeEvaluate(
  pluginName: string,
  returned: BeforeEvaluateResult,
): BeforeEvaluateReading {
  const refuse = (what: string): TypeError =>
    new TypeError(`plugin ${pluginName} beforeEvaluate returned ${what}`);
  const raw: unknown = returned;
  if (!isObject(raw)) throw refuse(`${describeValue(raw)}, not a result`);
  // Read by name, once each (own, non-enumerable or inherited getters alike), then copied.
  const snapshot = copyData({
    input: returned.input,
    rules: returned.rules,
    skipped: returned.skipped,
    state: returned.state,
  });

  const given = snapshot.input;
  if (!isObject(given) || !isObject(given.data) || !isObject(given.meta)) {
    throw refuse('a malformed input');
  }
  const input: EvaluationInput = { ...given, data: { ...given.data }, meta: { ...given.meta } };

  const rules = snapshot.rules;
  if (!Array.isArray(rules) || !rules.every(isObject)) throw refuse('a malformed rules');

  const skipped = snapshot.skipped ?? [];
  if (!Array.isArray(skipped) || !skipped.every(isSkip)) throw refuse('a malformed skipped');

  const state = snapshot.state;
  const stateNotJson = state === undefined ? undefined : findNonJson(state);
  if (stateNotJson !== undefined) throw refuse(`a state that is not JSON at ${stateNotJson}`);
  return {
    input,
    rules: [...rules],
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
