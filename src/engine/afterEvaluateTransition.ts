import { DEFAULT_OUTPUT, canonicalize } from '@run-iq/spec';
import type { EvaluationResult } from '../types/result.js';
import { describeValue } from '../utils/json.js';

/** What the engine keeps of a result returned by `afterEvaluate`, and what it says about it. */
export interface AfterEvaluateTransition {
  /** The accepted result, or `null` when the engine refuses it and keeps the previous one. */
  readonly result: EvaluationResult | null;
  /** One message per change the engine reports, in a fixed order (see `acceptAfterEvaluate`). */
  readonly messages: readonly string[];
}

/**
 * Accepts the result a plugin's `afterEvaluate` returned in place of `before`, the result the
 * plugin was handed a copy of (`before` itself is never written to).
 *
 * - `requestId`, `engineVersion`, `outputs`, `diagnostics` and `pluginState` belong to the
 *   engine: the values of `before` are kept, whatever the plugin returned.
 * - The only way to change an output is to rewrite `value`, which must be a finite number (the
 *   default output is a number): the output `value` of `outputs` is set to it, so that
 *   `value === outputs.value.value` holds. Any other rewritten value refuses the whole result
 *   (`result: null`).
 * - Returned `outputs` that differ (canonical form) both from those handed to the plugin and from
 *   those the engine keeps, e.g. an `outputs.value.value` changed without `value`, are ignored,
 *   with a message.
 * - The messages say, in this order: the rewrite of `value`, the ignored change of `outputs`,
 *   then the rule ids added to and removed from `appliedRules`, then those added to and removed
 *   from `skippedRules` (ids sorted, compared as multisets, so a pseudo-rule without a version is
 *   named too).
 *
 * Throws (`TypeError`...) when the plugin returned something that is not a result; the engine
 * reports it as an error of the hook.
 */
export function acceptAfterEvaluate(
  pluginName: string,
  before: EvaluationResult,
  returned: EvaluationResult,
): AfterEvaluateTransition {
  const messages: string[] = [];
  let outputs = before.outputs;

  if (returned.value !== before.value) {
    const value: unknown = returned.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        result: null,
        messages: [
          `plugin ${pluginName} rewrote output value to ${describeValue(value)}, ` +
            'not a finite number: result ignored',
        ],
      };
    }
    messages.push(
      `plugin ${pluginName} rewrote output value from ${describeValue(before.value)} to ${describeValue(value)}`,
    );
    const declared = before.outputs[DEFAULT_OUTPUT];
    if (declared !== undefined) {
      outputs = { ...before.outputs, [DEFAULT_OUTPUT]: { ...declared, value } };
    }
  }
  // Left as handed, or synced with the rewritten value by the plugin itself: no change of its own.
  if (!sameData(returned.outputs, before.outputs) && !sameData(returned.outputs, outputs)) {
    messages.push(`plugin ${pluginName} changed outputs directly; ignored (rewrite value instead)`);
  }

  const applied = changes(
    before.appliedRules.map((rule) => rule.id),
    returned.appliedRules.map((rule) => String(rule.id)),
  );
  const skipped = changes(
    before.skippedRules.map((skip) => skip.rule.id),
    returned.skippedRules.map((skip) => String(skip.rule.id)),
  );
  const say = (verb: string, list: string, ids: readonly string[]): void => {
    if (ids.length > 0) messages.push(`plugin ${pluginName} ${verb} ${list}: ${ids.join(', ')}`);
  };
  say('added', 'applied rules', applied.added);
  say('removed', 'applied rules', applied.removed);
  say('added', 'skipped rules', skipped.added);
  say('removed', 'skipped rules', skipped.removed);

  return {
    result: {
      ...returned,
      outputs,
      requestId: before.requestId,
      engineVersion: before.engineVersion,
      diagnostics: before.diagnostics,
      pluginState: before.pluginState,
    },
    messages,
  };
}

/** True when both values have the same canonical form; a value without one differs. */
function sameData(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

/** The ids of `after` not in `before`, and of `before` not in `after`, as multisets, sorted. */
function changes(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  return { added: minus(after, before), removed: minus(before, after) };
}

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
