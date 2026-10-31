import { DEFAULT_OUTPUT, canonicalize } from '@run-iq/spec';
import type { EvaluationResult } from '../types/result.js';
import { describeValue } from '../utils/json.js';
import { copyData, isObject } from '../utils/values.js';
import { isSkip, withDetail } from './beforeEvaluateResult.js';

/** What the engine keeps of a result returned by `afterEvaluate`, and what it says about it. */
export interface AfterEvaluateTransition {
  /** The accepted result, or `null` when the engine refuses it and keeps the previous one. */
  readonly result: EvaluationResult | null;
  /** One message per change the engine reports, in a fixed order (see `acceptAfterEvaluate`). */
  readonly messages: readonly string[];
}

/** The fields `afterEvaluate` may change; every other field belongs to the engine. */
export const PLUGIN_EDITABLE_FIELDS: ReadonlySet<string> = new Set([
  'value',
  'appliedRules',
  'skippedRules',
  'trace',
  'breakdown',
  'meta',
]);

/**
 * Accepts the result a plugin's `afterEvaluate` returned in place of `before`, the result the
 * plugin was handed a copy of (`before` itself is never written to).
 *
 * - **Single read.** The returned result is read once: a shallow copy (each getter or proxy
 *   trap runs once), then `copyData`. Every check runs on that snapshot, and the new result is
 *   built from it only.
 * - **Shape.** A result that is not an object, or whose `appliedRules` is not an array of
 *   objects, `skippedRules` not an array of `{ rule: object, reason: string, detail?: string }`,
 *   `breakdown` not an array, `trace` not an object or `meta` neither absent nor an object, throws
 *   `TypeError` (`plugin <name> afterEvaluate returned ...; ignored`): a hook error.
 * - **Engine-owned fields** are every field but `value`, `appliedRules`, `skippedRules`, `trace`,
 *   `breakdown` and `meta`: `requestId`, `engineVersion`, `outputs`, `diagnostics`,
 *   `missingFacts`, `pluginState`, `pluginVersions`, `dslVersions`, `timestamp`, `proof`,
 *   `fromStore`, and any field a plugin adds. The values of `before` are kept; those the plugin
 *   changed (canonical compare) are named in one message, `plugin <name> changed engine-owned
 *   fields <a, b>; ignored`, ending with ` (rewrite value instead)` when `outputs` is one of them.
 * - **`value`.** Rewriting it is the only way to change an output. It must be a finite number
 *   (the default output is a number): `outputs.value.value` is set to it, so that
 *   `value === outputs.value.value` holds. Any other rewritten value refuses the whole result
 *   (`result: null`). Returned `outputs` synced with the rewrite by the plugin itself are not a
 *   change.
 * - **Rules.** Ids added to and removed from `appliedRules` and `skippedRules` are compared as
 *   multisets (a pseudo-rule without a version is named too); an entry kept under the same id
 *   but different as a whole (canonical compare; for a skip, its reason and detail too) is
 *   named as changed. Skips without `detail` get `skipped by plugin <name>`.
 * - **Order of the messages:** the rewrite of `value`, the engine-owned fields, then for applied
 *   then skipped rules: added, removed, changed (ids sorted).
 */
export function acceptAfterEvaluate(
  pluginName: string,
  before: EvaluationResult,
  returned: EvaluationResult,
): AfterEvaluateTransition {
  const refuse = (what: string): TypeError =>
    new TypeError(`plugin ${pluginName} afterEvaluate returned ${what}; ignored`);
  const raw: unknown = returned;
  if (!isObject(raw)) throw refuse(`${describeValue(raw)}, not a result`);
  const snapshot = copyData({ ...returned });

  if (!Array.isArray(snapshot.appliedRules) || !snapshot.appliedRules.every(isObject)) {
    throw refuse('a malformed appliedRules');
  }
  if (!Array.isArray(snapshot.skippedRules) || !snapshot.skippedRules.every(isSkip)) {
    throw refuse('a malformed skippedRules');
  }
  if (!Array.isArray(snapshot.breakdown)) throw refuse('a malformed breakdown');
  if (!isObject(snapshot.trace)) throw refuse('a malformed trace');
  if (snapshot.meta !== undefined && !isObject(snapshot.meta)) throw refuse('a malformed meta');

  const messages: string[] = [];
  let value: unknown = before.value;
  let outputs = before.outputs;
  if (snapshot.value !== before.value) {
    const rewritten: unknown = snapshot.value;
    if (typeof rewritten !== 'number' || !Number.isFinite(rewritten)) {
      return {
        result: null,
        messages: [
          `plugin ${pluginName} rewrote output value to ${describeValue(rewritten)}, ` +
            'not a finite number: result ignored',
        ],
      };
    }
    messages.push(
      `plugin ${pluginName} rewrote output value from ${describeValue(before.value)} to ${describeValue(rewritten)}`,
    );
    value = rewritten;
    const declared = before.outputs[DEFAULT_OUTPUT];
    if (declared !== undefined) {
      outputs = { ...before.outputs, [DEFAULT_OUTPUT]: { ...declared, value: rewritten } };
    }
  }

  const owned = changedEngineFields(before, snapshot, outputs);
  if (owned.length > 0) {
    const hint = owned.includes('outputs') ? ' (rewrite value instead)' : '';
    messages.push(
      `plugin ${pluginName} changed engine-owned fields ${owned.join(', ')}; ignored${hint}`,
    );
  }

  const say = (verb: string, list: string, ids: readonly string[]): void => {
    if (ids.length > 0) messages.push(`plugin ${pluginName} ${verb} ${list}: ${ids.join(', ')}`);
  };
  const report = <T extends object>(
    list: string,
    beforeEntries: readonly T[],
    afterEntries: readonly T[],
    idOf: (entry: T) => string,
  ): void => {
    const beforeIds = beforeEntries.map(idOf);
    const afterIds = afterEntries.map(idOf);
    say('added', list, minus(afterIds, beforeIds));
    say('removed', list, minus(beforeIds, afterIds));
    say('changed', list, changedEntries(beforeEntries, afterEntries, idOf));
  };
  const ruleId = (rule: object): string => String(Reflect.get(rule, 'id'));
  report('applied rules', before.appliedRules, snapshot.appliedRules, ruleId);
  report('skipped rules', before.skippedRules, snapshot.skippedRules, (skip) => ruleId(skip.rule));

  return {
    result: {
      ...before,
      value,
      outputs,
      appliedRules: snapshot.appliedRules,
      skippedRules: snapshot.skippedRules.map((skip) => withDetail(skip, pluginName)),
      trace: snapshot.trace,
      breakdown: snapshot.breakdown,
      meta: snapshot.meta,
    },
    messages,
  };
}

/** The engine-owned fields the snapshot changed, sorted. */
function changedEngineFields(
  before: EvaluationResult,
  snapshot: EvaluationResult,
  syncedOutputs: EvaluationResult['outputs'],
): string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(snapshot)]);
  const changed: string[] = [];
  for (const field of fields) {
    if (PLUGIN_EDITABLE_FIELDS.has(field)) continue;
    const mine: unknown = Reflect.get(before, field);
    const theirs: unknown = Reflect.get(snapshot, field);
    // Outputs left as handed, or synced with the rewritten value by the plugin itself.
    const same = sameData(mine, theirs) || (field === 'outputs' && sameData(syncedOutputs, theirs));
    if (!same) changed.push(field);
  }
  return changed.sort();
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

/** Ids whose entries, paired by id in order, differ as a whole; sorted, each once. */
function changedEntries<T extends object>(
  before: readonly T[],
  after: readonly T[],
  idOf: (entry: T) => string,
): string[] {
  const pending = new Map<string, T[]>();
  for (const entry of before) {
    const id = idOf(entry);
    pending.set(id, [...(pending.get(id) ?? []), entry]);
  }
  const changed = new Set<string>();
  for (const entry of after) {
    const id = idOf(entry);
    const original = pending.get(id)?.shift();
    if (original !== undefined && !sameData(original, entry)) changed.add(id);
  }
  return [...changed].sort();
}

/** The ids of `from` not matched in `take`, as multisets, sorted. */
function minus(from: readonly string[], take: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const id of take) left.set(id, (left.get(id) ?? 0) + 1);
  const rest: string[] = [];
  for (const id of from) {
    const count = left.get(id) ?? 0;
    if (count > 0) left.set(id, count - 1);
    else rest.push(id);
  }
  return rest.sort();
}
