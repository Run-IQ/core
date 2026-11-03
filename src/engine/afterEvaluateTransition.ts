import type { UnsealedResult } from '../types/result.js';
import { describeValue, findNonJson } from '../utils/json.js';
import type { EngineLimits } from '../limits.js';
import { isObject } from '../utils/values.js';
import { isPlainPrototype } from '../utils/plain.js';
import { Budget, guarded, readBounded } from './pluginBoundary.js';
import { refusal } from './pluginPort.js';
import { clip } from '../utils/frozenCopy.js';

/** What the engine keeps of what `afterEvaluate` returned. */
export interface AfterEvaluateTransition {
  /** The result: the decision as it was, with the annotations the plugin set under its name. */
  readonly result: UnsealedResult;
}

/**
 * Takes the annotations an `afterEvaluate` returned. The hook returns annotations, not a result:
 * nothing, or `{ annotations?: <JSON object> }`, and nothing else. The annotations are read once
 * through the reader (copied, bounded, their text weighed against the one budget of the
 * evaluation, their text counted in the record room) and merged into `meta` under the plugin's
 * name. The result is not copied: the decision cannot be changed by a plugin, because a plugin
 * cannot return anything that would change it.
 *
 * Throws (the engine turns it into a `PluginHookError`) for a return that is not nothing or a
 * plain object, for a field other than `annotations`, for annotations that are not a JSON object.
 */
export function acceptAfterEvaluate(
  pluginName: string,
  before: UnsealedResult,
  returned: unknown,
  limits: Readonly<EngineLimits>,
  joint: Budget,
): AfterEvaluateTransition {
  return guarded(() => accept(pluginName, before, returned, limits, joint));
}

function accept(
  pluginName: string,
  before: UnsealedResult,
  returned: unknown,
  limits: Readonly<EngineLimits>,
  joint: Budget,
): AfterEvaluateTransition {
  const refuse = (what: string): Error =>
    refusal(`plugin ${pluginName} afterEvaluate returned ${what}`);
  if (returned === undefined) return { result: before };
  if (!isObject(returned) || typeof returned !== 'object' || returned === null) {
    throw refuse(`${describeValue(returned)}, not annotations`);
  }
  if (Array.isArray(returned) || !isPlainPrototype(Object.getPrototypeOf(returned))) {
    throw refuse('something that is not a plain object');
  }
  for (const key of Reflect.ownKeys(returned)) {
    if (key !== 'annotations') {
      throw refuse(
        `a field other than annotations: ${clip(typeof key === 'symbol' ? key.toString() : key)}`,
      );
    }
  }
  // Read once, here: a getter answers once and the answer is the one that is kept.
  const given: unknown = (returned as { annotations?: unknown }).annotations;
  // `undefined` alone means "nothing to annotate"; `{}` and `{ annotations: undefined }` do not.
  if (given === undefined) throw refuse('no annotations at /annotations');
  if (!isObject(given) || Array.isArray(given)) throw refuse('annotations that are not an object');
  const charsBefore = joint.readChars;
  const annotations = readBounded(given, limits, 'annotations', { budget: joint });
  // Their text is certain to be in the record.
  joint.record(joint.readChars - charsBefore);
  if (Reflect.ownKeys(annotations as object).length === 0) {
    throw refuse('empty annotations at /annotations');
  }
  const notJson = findNonJson(annotations);
  if (notJson !== undefined) throw refuse(`annotations that are not JSON at ${notJson}`);
  const meta: Record<string, unknown> = { ...(before.meta ?? {}) };
  Object.defineProperty(meta, pluginName, {
    value: annotations,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return { result: { ...before, meta } };
}
