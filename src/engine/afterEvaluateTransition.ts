import { canonicalize } from '@run-iq/spec';
import type { JsonValue } from '@run-iq/spec';
import type { UnsealedResult } from '../types/result.js';
import { describeValue, findNonJson } from '../utils/json.js';
import type { EngineLimits } from '../limits.js';
import { isObject } from '../utils/values.js';
import { Budget, readBounded, resultLimits } from './pluginBoundary.js';

/** What the engine keeps of a result returned by `afterEvaluate`. */
export interface AfterEvaluateTransition {
  /** The accepted result: the decision as it was, with the annotations the plugin set. */
  readonly result: UnsealedResult;
}

/**
 * What `afterEvaluate` may set: `meta` (annotations on the result) and its own entry of
 * `pluginState`. Everything else is the decision, and the decision is the engine's.
 */
export const PLUGIN_SETTABLE_FIELDS: ReadonlySet<string> = new Set(['meta', 'pluginState']);

/**
 * Accepts the result a plugin's `afterEvaluate` returned in place of `before`, the result the
 * plugin was handed a copy of (`before` itself is never written to).
 *
 * - **Single read.** Every field of `before`, every enumerable field of the returned result and
 *   `meta` and `pluginState` are read by name, once each (an own, non-enumerable or inherited
 *   getter runs once), then copied, each on its own and bounded by `limits` (`readBounded`).
 *   Every check runs on that copy only.
 * - **The decision does not change.** A change to `value`, `outputs`, `appliedRules`,
 *   `skippedRules`, `breakdown`, `trace`, or to any other field of the result (also one the
 *   plugin adds), compared in canonical form, throws `TypeError` (`plugin <name> afterEvaluate
 *   changed the decision: <fields>`). So does a change to the `pluginState` entry of another
 *   plugin, or the removal of one.
 * - **What it may set.** `meta` (an object of JSON, or nothing: it may add keys, and changing or removing
 *   one set before is refused) and `pluginState[<its name>]` (JSON).
 * - **Shape.** A result that is not an object, a `meta` that is neither absent nor an object, a
 *   `pluginState` that is not an object, or an entry that is not JSON, throws `TypeError`.
 *
 * The engine turns every throw into a `PluginHookError`: nothing of the result is used.
 */
export function acceptAfterEvaluate(
  pluginName: string,
  before: UnsealedResult,
  handed: UnsealedResult,
  returned: UnsealedResult,
  limits: Readonly<EngineLimits>,
): AfterEvaluateTransition {
  const refuse = (what: string): TypeError =>
    new TypeError(`plugin ${pluginName} afterEvaluate returned ${what}`);
  const raw: unknown = returned;
  if (!isObject(raw) || typeof raw !== 'object' || raw === null) {
    throw refuse(`${describeValue(raw)}, not a result`);
  }
  // Each field is read by name, once, whatever the kind of property. A field the result was not
  // handed with (and that a plugin may not set) is a change, named without being copied. A field
  // that is the very object it was handed is unchanged: the handed view is frozen, so there is
  // nothing to read. Any other field is copied, bounded (leaves and depth, all fields against one
  // budget) and without recursion.
  const fields = new Set([...Object.keys(before), ...Object.keys(raw), ...PLUGIN_SETTABLE_FIELDS]);
  const theirs: Record<string, unknown> = {};
  const changed: string[] = [];
  let bounds: Readonly<EngineLimits> | undefined;
  let budget: Budget | undefined;
  const keep = (field: string, value: unknown): void => {
    // defineProperty: a field named `__proto__` stays a field.
    Object.defineProperty(theirs, field, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const field of fields) {
    const value: unknown = Reflect.get(raw, field);
    const settable = PLUGIN_SETTABLE_FIELDS.has(field);
    if (!settable && !Object.hasOwn(before, field)) {
      changed.push(field);
      continue;
    }
    if (value === Reflect.get(handed, field)) {
      keep(field, Reflect.get(before, field));
      continue;
    }
    bounds ??= resultLimits(before, limits);
    budget ??= new Budget('maxInputLeaves', bounds.maxInputLeaves);
    keep(field, readBounded(value, bounds, field, { budget, allowUndefined: true }));
  }

  // A field the plugin left out was read as `undefined`: it differs, so it counts as changed.
  for (const [field, value] of Object.entries(theirs)) {
    if (PLUGIN_SETTABLE_FIELDS.has(field)) continue;
    // The very object of the result: it is unchanged, with nothing to compare.
    if (value === Reflect.get(before, field)) continue;
    if (!sameData(Reflect.get(before, field), value)) changed.push(field);
  }
  const meta: unknown = theirs['meta'];
  if (meta !== undefined && !isObject(meta)) throw refuse('a malformed meta');
  const metaNotJson = meta === undefined ? undefined : findNonJson(meta);
  if (metaNotJson !== undefined) throw refuse(`a meta that is not JSON at ${metaNotJson}`);
  // A plugin may add annotations; changing or removing one another plugin set is a change to
  // the record, as for `pluginState`.
  const metaChanged: string[] = [];
  for (const [name, set] of Object.entries(before.meta ?? {})) {
    const kept: unknown = meta === undefined ? undefined : Reflect.get(meta as object, name);
    if (!sameData(set, kept)) metaChanged.push(name);
  }
  if (metaChanged.length > 0) {
    throw new TypeError(
      `plugin ${pluginName} afterEvaluate changed meta keys another plugin set: ${metaChanged.sort().join(', ')}`,
    );
  }

  const state: unknown = theirs['pluginState'];
  if (typeof state !== 'object' || state === null || !isObject(state)) {
    throw refuse('a malformed pluginState');
  }
  const stateBefore: Readonly<Record<string, JsonValue>> = before.pluginState;
  const pluginState: Record<string, JsonValue> = {};
  for (const name of new Set([...Object.keys(stateBefore), ...Object.keys(state)])) {
    const given: unknown = Reflect.get(state, name);
    if (name === pluginName) {
      if (given === undefined) continue;
      const notJson = findNonJson(given);
      if (notJson !== undefined) throw refuse(`a pluginState that is not JSON at ${notJson}`);
      Object.defineProperty(pluginState, name, {
        value: given as JsonValue,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }
    if (!sameData(Reflect.get(stateBefore, name), given)) {
      if (!changed.includes('pluginState')) changed.push('pluginState');
      continue;
    }
    Object.defineProperty(pluginState, name, {
      value: given as JsonValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  if (changed.length > 0) {
    throw new TypeError(
      `plugin ${pluginName} afterEvaluate changed the decision: ${changed.sort().join(', ')}`,
    );
  }

  return {
    result: {
      ...before,
      pluginState,
      meta: meta as Record<string, unknown> | undefined,
    },
  };
}

/** True when both values have the same canonical form; a value without one differs. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}
