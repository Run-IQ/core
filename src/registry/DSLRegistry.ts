import type { DSLEvaluator } from '../types/dsl.js';
import { copyDeclaration } from './ModelRegistry.js';
import { isolated } from '../engine/trust.js';
import type { DslDescriptor } from '../types/plugin.js';
import { callSync, readIdentity, registering } from '../engine/pluginPort.js';

type Fn = (...args: never[]) => unknown;

/** What the engine took from an evaluator when it was registered, and keeps. */
interface Declared {
  readonly version: string;
  readonly capabilities: DSLEvaluator['capabilities'];
  readonly evaluate: Fn;
  readonly listVariables: Fn | undefined;
  readonly compute: Fn | undefined;
  readonly evaluateTruth: Fn | undefined;
}

/**
 * The DSL evaluators by name. An evaluator is read once, when it is registered (its `dsl` and
 * `version`, its `capabilities` and its functions); the engine keeps those copies and never reads
 * it again.
 */
/** The keys a DSL's `capabilities` may have (a strict list: `exactDecimals`, `threeValued`, `limits`). */
const CAPABILITY_KEYS = ['exactDecimals', 'threeValued', 'limits'] as const;

/**
 * Checks what a DSL promises, once, on the engine's own copy: a plain object whose `exactDecimals`
 * is `true` or `false`, whose `threeValued`, when present, is `true` or `false`, whose `limits`, when
 * present, is a plain object, and with no other key. A shape that is anything else refuses the
 * registration, naming the DSL and the field.
 */
function validateCapabilities(dsl: string, capabilities: DSLEvaluator['capabilities']): void {
  if (capabilities === undefined) return;
  const named = (field: string, problem: string): Error =>
    new TypeError(`DSL evaluator "${dsl}": ${field} ${problem}`);
  const declared = capabilities as unknown as Record<string, unknown>;
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    throw named('capabilities', 'must be an object');
  }
  for (const key of Object.keys(declared)) {
    if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) {
      throw named(`capabilities.${key}`, 'is not a known capability');
    }
  }
  if (typeof declared['exactDecimals'] !== 'boolean') {
    throw named('capabilities.exactDecimals', 'must be true or false');
  }
  if (declared['threeValued'] !== undefined && typeof declared['threeValued'] !== 'boolean') {
    throw named('capabilities.threeValued', 'must be true or false');
  }
  const limits = declared['limits'];
  if (
    limits !== undefined &&
    (typeof limits !== 'object' || limits === null || Array.isArray(limits))
  ) {
    throw named('capabilities.limits', 'must be an object');
  }
}

export class DSLRegistry {
  private readonly evaluators = new Map<string, DSLEvaluator>();
  private readonly declared = new Map<string, Declared>();

  register(evaluator: DSLEvaluator): void {
    isolated(() => this.add(evaluator));
  }

  private add(evaluator: DSLEvaluator): void {
    registering(() => {
      const { name: dsl, version } = readIdentity(evaluator, 'DSL', 'dsl');
      if (this.evaluators.has(dsl)) {
        throw new Error(`DSL evaluator "${dsl}" is already registered`);
      }
      const given: unknown = evaluator.capabilities; // read once
      const capabilities =
        given === undefined
          ? undefined
          : (copyDeclaration(given, dsl, '/capabilities') as DSLEvaluator['capabilities']);
      validateCapabilities(dsl, capabilities);
      const truth: unknown = evaluator.evaluateTruth; // read once
      if (capabilities?.threeValued === true && typeof truth !== 'function') {
        throw new TypeError(
          `DSL evaluator "${dsl}": evaluateTruth must be a function when capabilities.threeValued is true`,
        );
      }
      const functionOf = (key: keyof DSLEvaluator, required: boolean): Fn | undefined => {
        const fn: unknown = evaluator[key];
        if (typeof fn === 'function') return fn as Fn;
        if (required || fn !== undefined) {
          throw new TypeError(`DSL evaluator "${dsl}": ${String(key)} must be a function`);
        }
        return undefined;
      };
      const truthOf = (given: unknown): Fn | undefined => {
        if (typeof given === 'function') return given as Fn;
        if (given !== undefined) {
          throw new TypeError(`DSL evaluator "${dsl}": evaluateTruth must be a function`);
        }
        return undefined;
      };
      this.evaluators.set(dsl, evaluator);
      this.declared.set(dsl, {
        version,
        capabilities,
        evaluate: functionOf('evaluate', true) as Fn,
        listVariables: functionOf('listVariables', false),
        compute: functionOf('compute', false),
        // Read once, like `evaluate`; a three-valued DSL must have one (checked above).
        evaluateTruth: truthOf(truth),
      });
    });
  }

  /** What a plugin may know of a registered evaluator: frozen data, no object, no function. */
  describe(dsl: string): DslDescriptor | undefined {
    return isolated(() => {
      const declared = this.declared.get(dsl);
      return declared === undefined ? undefined : Object.freeze({ dsl, version: declared.version });
    });
  }

  /** The descriptors of every registered evaluator, frozen. */
  describeAll(): ReadonlyArray<DslDescriptor> {
    return isolated(() =>
      Object.freeze(
        [...this.declared].map(([dsl, declared]) =>
          Object.freeze({ dsl, version: declared.version }),
        ),
      ),
    );
  }

  get(dsl: string): DSLEvaluator | undefined {
    return this.evaluators.get(dsl);
  }

  has(dsl: string): boolean {
    return this.evaluators.has(dsl);
  }

  /** A copy: writing to it changes nothing in the registry. */
  getAll(): ReadonlyMap<string, DSLEvaluator> {
    return new Map(this.evaluators);
  }

  /** The versions of the evaluators, as registered. */
  versions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, declared] of this.declared) out[name] = declared.version;
    return out;
  }
}

/** A registry fixed at this moment: what was taken at registration is what runs. Internal. */
export function snapshotDsls(registry: DSLRegistry): DSLRegistry {
  const source = registry as unknown as {
    evaluators: Map<string, DSLEvaluator>;
    declared: Map<string, Declared>;
  };
  const fixed = new DSLRegistry();
  const target = fixed as unknown as typeof source;
  for (const [name, evaluator] of source.evaluators) {
    // justification: `register` sets both maps together.
    const declared = source.declared.get(name) as Declared;
    target.evaluators.set(name, fixEvaluator(name, evaluator, declared));
    target.declared.set(name, declared);
  }
  return fixed;
}

/** A frozen record of `evaluator`: its functions as registered, each called through the port. */
function fixEvaluator(dsl: string, evaluator: DSLEvaluator, declared: Declared): DSLEvaluator {
  const { listVariables, compute } = declared;
  return Object.freeze({
    dsl,
    version: declared.version,
    evaluate: (expression: unknown, context: Record<string, unknown>) =>
      callSync(declared.evaluate, evaluator, [expression, context]) as boolean,
    ...(listVariables === undefined
      ? {}
      : {
          listVariables: (expression: unknown) =>
            // justification: `callSync` returns what the plugin answered; its reader checks it.
            callSync(listVariables, evaluator, [expression]) as never,
        }),
    ...(compute === undefined
      ? {}
      : {
          compute: (expression: unknown, context: Record<string, unknown>) =>
            // justification: as above; `compute` is inert in 9L and its answer is read by the caller.
            callSync(compute, evaluator, [expression, context]) as never,
        }),
    ...(declared.capabilities === undefined ? {} : { capabilities: declared.capabilities }),
  });
}
