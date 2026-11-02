import { ENGINE_VARIABLES } from '@run-iq/spec';
import type { Reads } from './reads.js';

/** What a context is built from. */
export interface ContextBase {
  /** The input's `data`: its root keys become the root of the context. */
  readonly data: Readonly<Record<string, unknown>>;
  /** `meta.dates` as `normalizeMeta` writes it: `/$dates/<name>`. */
  readonly dates: Readonly<Record<string, string>>;
  /** `meta.dimensions` as `normalizeMeta` writes it: `/$dimensions/<name>`. */
  readonly dimensions: Readonly<Record<string, string | readonly string[]>>;
  /** The outputs computed so far, by name; only those a rule reads enter its context. */
  readonly outputs?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The engine variables an instance of a rule may add (`$item`, `$index`, `$params`, ...): the
 * reserved names that `buildContext` does not build itself. Their meaning belongs to the tasks
 * that create instances; 9L only carries them.
 */
export interface ContextInstance {
  readonly [variable: `$${string}`]: unknown;
}

const BUILT_HERE: ReadonlySet<string> = new Set(['$dates', '$dimensions', '$outputs']);
const INSTANCE_VARIABLES: ReadonlySet<string> = new Set(
  ENGINE_VARIABLES.filter((name) => !BUILT_HERE.has(name)),
);

/**
 * The evaluation context of one rule (D-1, D-3): `base.data` at the root, then `$dates`,
 * `$dimensions` and `$outputs` reduced to the outputs listed in `reads.outputs` that exist, then
 * the variables of `instance`. The context and each `$` object it builds are frozen; `data` is
 * the caller's, neither copied nor frozen (a copy per rule would not scale): its nested values
 * are shared. Throws `TypeError` for an instance variable that is not an engine variable or
 * that the context builds itself.
 */
export function buildContext(
  base: ContextBase,
  reads: Pick<Reads, 'outputs'>,
  instance?: ContextInstance,
): Readonly<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const name of reads.outputs) {
    if (base.outputs !== undefined && Object.hasOwn(base.outputs, name)) {
      outputs[name] = base.outputs[name];
    }
  }
  const context: Record<string, unknown> = { ...base.data };
  if (instance !== undefined) {
    for (const [name, value] of Object.entries(instance)) {
      if (!INSTANCE_VARIABLES.has(name)) {
        throw new TypeError(`buildContext: ${name} is not an instance variable`);
      }
      context[name] = value;
    }
  }
  context['$dates'] = Object.freeze({ ...base.dates });
  context['$dimensions'] = Object.freeze({ ...base.dimensions });
  context['$outputs'] = Object.freeze(outputs);
  return Object.freeze(context);
}
