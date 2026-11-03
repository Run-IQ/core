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
}

/**
 * The DSL evaluators by name. An evaluator is read once, when it is registered (its `dsl` and
 * `version`, its `capabilities` and its functions); the engine keeps those copies and never reads
 * it again.
 */
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
      const functionOf = (key: keyof DSLEvaluator, required: boolean): Fn | undefined => {
        const fn: unknown = evaluator[key];
        if (typeof fn === 'function') return fn as Fn;
        if (required || fn !== undefined) {
          throw new TypeError(`DSL evaluator "${dsl}": ${String(key)} must be a function`);
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
            callSync(listVariables, evaluator, [expression]) as never,
        }),
    ...(compute === undefined
      ? {}
      : {
          compute: (expression: unknown, context: Record<string, unknown>) =>
            callSync(compute, evaluator, [expression, context]) as never,
        }),
    ...(declared.capabilities === undefined ? {} : { capabilities: declared.capabilities }),
  });
}
