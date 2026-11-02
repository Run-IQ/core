import type { JsonValue } from '@run-iq/spec';
import type { EngineLimits } from '../limits.js';
import type { BeforeEvaluateResult } from '../types/plugin.js';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import { describeValue, findNonJson } from '../utils/json.js';
import { isObject } from '../utils/values.js';
import { PLUGIN_SKIP_REASONS, readBounded, readItems, readSkips } from './pluginBoundary.js';
import type { Budget } from './pluginBoundary.js';

/** What the engine takes from a `beforeEvaluate` result, read once and checked. */
export interface BeforeEvaluateReading {
  /**
   * The input as the hook returned it, read once and not copied here: the engine copies it, bounds
   * it and checks it (`InputSanitizer.prepare`), which reads each member once.
   */
  readonly input: unknown;
  /** The returned rules: new frozen copies, at most `maxRules`, each bounded on its own. */
  readonly rules: readonly Rule[];
  /** The plugin's skips, each with a plugin reason and a `detail` (`skipped by plugin <name>`). */
  readonly skipped: readonly SkippedRule[];
  /** The JSON state to keep, when the plugin returned one. */
  readonly state?: JsonValue | undefined;
}

/**
 * Reads what a plugin's `beforeEvaluate` returned, once: `input`, `rules`, `skipped` and `state`
 * are read by name, once each (an own, non-enumerable or inherited getter runs a single time);
 * `rules` and `skipped` are lists whose `length` is read once and whose items are read once and
 * copied (`readItems`), `state` is copied (`readBounded`), all bounded by `limits` without
 * recursion. The engine uses only those copies.
 *
 * Throws `TypeError` (`plugin <name> beforeEvaluate returned ...`) when the result is not an
 * object, when `input` is not an object, when `rules` is not a list of objects, when `skipped` is
 * neither absent nor a list of `{ rule: object, reason, detail? }` with a plugin reason and no
 * other key, or when `state` is not JSON (`a state that is not JSON at $.a[1] (Date)`); a getter
 * that throws while the result is read throws too. Throws `EngineLimitError` past `maxRules`,
 * `maxInputLeaves` or `maxInputDepth`. The engine then fails the evaluation
 * (`PluginHookError`): nothing of the result is used.
 */
export function readBeforeEvaluate(
  pluginName: string,
  returned: BeforeEvaluateResult,
  limits: Readonly<EngineLimits>,
  budget: Budget,
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
  const rules = readItems(rulesIn, limits, 'rules', budget);
  if (!rules.every(isObject)) throw refuse('a malformed rules');

  if (skippedIn !== undefined && !Array.isArray(skippedIn)) throw refuse('a malformed skipped');
  let records: ReturnType<typeof readSkips>;
  try {
    records = readSkips(skippedIn ?? [], limits, budget);
  } catch (error) {
    if (error instanceof TypeError) throw refuse('a malformed skipped');
    throw error;
  }
  const skipped: SkippedRule[] = records.map((record) => {
    const { rule, reason, detail } = record;
    if (!isObject(rule) || typeof reason !== 'string') throw refuse('a malformed skipped');
    if (detail !== undefined && typeof detail !== 'string') throw refuse('a malformed skipped');
    // A reason of the engine's own stages is not the plugin's to give.
    if (!PLUGIN_SKIP_REASONS.has(reason)) {
      throw refuse(
        `a skip with the reason ${JSON.stringify(reason)}: a plugin skip has one of ${[...PLUGIN_SKIP_REASONS].join(', ')}`,
      );
    }
    // justification: `rule` is an object and `reason` a string in the plugin set (checked above);
    // the ledger checks `rule` as a rule.
    return { rule: rule as Rule, reason: reason as SkippedRule['reason'], detail };
  });

  // justification: typed as JSON only to be handed to `findNonJson` on the next line, which checks
  // it before anything uses it.
  const state = readBounded(stateIn, limits, 'state', { budget }) as JsonValue | undefined;
  const stateNotJson = state === undefined ? undefined : findNonJson(state);
  if (stateNotJson !== undefined) throw refuse(`a state that is not JSON at ${stateNotJson}`);
  return {
    input,
    // justification: every item was checked to be an object; the ledger checks them as rules.
    rules: rules as Rule[],
    skipped,
    state,
  };
}
