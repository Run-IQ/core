import { ViewScope } from '../engine/frozenView.js';
import { parsePointer } from '@run-iq/spec';
import type { JsonPointer } from '@run-iq/spec';
import type { CalculationModel } from '../types/model.js';
import type { DSLEvaluator } from '../types/dsl.js';
import type { OutputValue } from '../types/output.js';
import type { Rule } from '../types/rule.js';
import { describeValue } from '../utils/json.js';
import { describeThrown } from '../utils/values.js';
import { isRaisedLimit } from '../errors/EngineLimitError.js';
import { clip } from '../utils/frozenCopy.js';
import { defaultCrossing, readBounded } from '../engine/pluginBoundary.js';
import { reading } from '../engine/pluginPort.js';
import type { Crossing } from '../engine/pluginBoundary.js';

/** Why a `listVariables` is not taken as it is (D-39, D-1). */
export interface ReadsProblem {
  /**
   * `failed`: it threw, or did not return a list; `non-pointer`: an item is not a JSON pointer;
   * `invalid-path`: an item is a pointer that names nothing to read (a `-` segment).
   */
  readonly kind: 'failed' | 'non-pointer' | 'invalid-path';
  /** `listVariables of <dsl|model> for <id@version> ...`, ready for a diagnostic. */
  readonly message: string;
}

/** What a rule reads from the evaluation context. */
export interface Reads {
  /** The pointers read by the condition and by the model, in order of appearance, once each. */
  readonly pointers: string[];
  /**
   * The outputs among them, in order of appearance: the name after `$outputs`, `$bounds` or
   * `$selected` (one name, whichever of the three is read).
   */
  readonly outputs: string[];
  /**
   * True when every part of the rule that reads (the condition's DSL, the model) declared its
   * reads with a conforming `listVariables`. False for a missing `listVariables` and for any
   * problem: the rule then reads unknown things (D-39; the effect on its status is 9M1's).
   */
  readonly declared: boolean;
  /** Each way a `listVariables` did not conform; empty when it was absent or conforming. */
  readonly problems: ReadsProblem[];
}

/**
 * The most pointers one `listVariables` may return. A rule reads a handful of facts; the cap
 * keeps a hostile plugin from making the engine walk a list of any length (the list is refused
 * before one item is read).
 */
export const MAX_LISTED_POINTERS = 100_000;

/** The engine variables whose second segment names an output. */
const OUTPUT_VARIABLES: ReadonlySet<string> = new Set(['$outputs', '$bounds', '$selected']);

/**
 * What `rule` reads: the pointers of its condition (`dsl.listVariables(condition.value)`) and
 * of its model (`model.listVariables(params)`) joined. A source that conforms contributes all of
 * its pointers. A `listVariables` that throws or returns no list contributes nothing; an item
 * that is not a pointer, or that names nothing to read (`/a/-`), is left out and named; any of
 * these, like a DSL or model without `listVariables`, makes `declared` false. A rule without
 * condition does not ask the DSL. Pointers are kept as written: no index or Unicode
 * normalization (`/enfants/01/age` and `/enfants/1/age` are two facts).
 */
export function readsOf(
  rule: Rule,
  dsl: DSLEvaluator | undefined,
  model: CalculationModel<OutputValue> | undefined,
  crossing: Crossing = defaultCrossing(),
): Reads {
  const label = `${rule.id}@${rule.version}`;
  const pointers = new Set<JsonPointer>();
  const outputs = new Set<string>();
  const problems: ReadsProblem[] = [];
  let declared = true;

  const problem = (kind: ReadsProblem['kind'], source: string, what: string): void => {
    problems.push({ kind, message: clip(`listVariables of ${source} for ${label} ${what}`) });
    declared = false;
  };

  const collect = (source: string, ask: () => unknown): void => {
    let items: unknown[];
    try {
      // The answer crosses once, through the one reader: copied, bounded, its text weighed.
      const raw = ask();
      // The length is read once and capped before one item is read.
      const length = reading(() => (Array.isArray(raw) ? raw.length : 0));
      if (length > MAX_LISTED_POINTERS) {
        throw new RangeError(`${length} pointers, more than the ${MAX_LISTED_POINTERS} allowed`);
      }
      const answer = readBounded(raw, crossing.limits, `listVariables of ${source}`, {
        leafLimit: 'maxInputLeaves',
        budget: crossing.budget,
        budgetMode: 'text',
      });
      // The contract is an array: an iterable, an array-like or a Set is not a list, and a lazy
      // one is never run. The length is read once and capped before any item is read.
      if (!Array.isArray(answer))
        throw new TypeError(`${reading(() => describeValue(raw))} is not a list`);
      items = [];
      for (let index = 0; index < answer.length; index += 1) items.push(answer[index]);
    } catch (error) {
      // A bound of the engine is not a plugin that failed: it is named, and it ends the evaluation.
      if (isRaisedLimit(error)) throw error;
      problem('failed', source, `failed: ${describeThrown(error)}`);
      return;
    }
    for (const item of items) {
      let segments: string[];
      try {
        if (typeof item !== 'string') throw new TypeError('not a string');
        segments = parsePointer(item);
      } catch {
        const shown = typeof item === 'string' ? item : describeValue(item);
        problem('non-pointer', source, `returned a non-pointer: ${shown}`);
        continue;
      }
      const [variable, name] = segments;
      // Nothing reads "all outputs" or the whole context in wave 1: such a rule would be ordered
      // as reading no output. It is an invalid path, so the rule's reads are unknown (D-39).
      const whole =
        variable === undefined
          ? 'the whole context'
          : OUTPUT_VARIABLES.has(variable) && name === undefined
            ? `all of ${variable}`
            : undefined;
      if (whole !== undefined) {
        problem(
          'invalid-path',
          source,
          `returned an invalid path: ${item === '' ? "''" : String(item)} (${whole} is not a fact to read)`,
        );
        continue;
      }
      if (segments.includes('-')) {
        problem(
          'invalid-path',
          source,
          `returned an invalid path: ${String(item)} ('-' is not an index)`,
        );
        continue;
      }
      pointers.add(item as JsonPointer);
      if (variable !== undefined && OUTPUT_VARIABLES.has(variable) && name !== undefined) {
        outputs.add(name);
      }
    }
  };

  if (rule.condition !== undefined) {
    if (dsl?.listVariables === undefined) declared = false;
    else {
      const value = rule.condition.value;
      collect(rule.condition.dsl, () => dsl.listVariables?.(new ViewScope().trapped(value)));
    }
  }
  if (model?.listVariables === undefined) declared = false;
  else {
    const params = rule.params;
    collect(model.name, () => model.listVariables?.(new ViewScope().trapped(params)));
  }

  return { pointers: [...pointers], outputs: [...outputs], declared, problems };
}
