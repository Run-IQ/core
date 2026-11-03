import type { DSLEvaluator } from '../types/dsl.js';
import { copyDeclaration } from './ModelRegistry.js';
import { isAnyViewError } from '../engine/frozenView.js';
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

  /** A registry fixed at this moment: what was taken at registration is what runs. */
  snapshot(): DSLRegistry {
    const fixed = new DSLRegistry();
    for (const [name, evaluator] of this.evaluators) {
      // justification: `register` sets both maps together.
      const declared = this.declared.get(name) as Declared;
      fixed.evaluators.set(name, fixEvaluator(name, evaluator, declared));
      fixed.declared.set(name, declared);
    }
    return fixed;
  }

  /** The versions of the evaluators, as registered. */
  versions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, declared] of this.declared) out[name] = declared.version;
    return out;
  }
}

/** A frozen record of `evaluator`: its functions as registered, each called through the port. */
function fixEvaluator(dsl: string, evaluator: DSLEvaluator, declared: Declared): DSLEvaluator {
  const { listVariables, compute } = declared;
  return Object.freeze({
    dsl,
    version: declared.version,
    evaluate: (expression: unknown, context: Record<string, unknown>) =>
      callSync(declared.evaluate, evaluator, [expression, context], isAnyViewError) as boolean,
    ...(listVariables === undefined
      ? {}
      : {
          listVariables: (expression: unknown) =>
            callSync(listVariables, evaluator, [expression], isAnyViewError) as never,
        }),
    ...(compute === undefined
      ? {}
      : {
          compute: (expression: unknown, context: Record<string, unknown>) =>
            callSync(compute, evaluator, [expression, context], isAnyViewError) as never,
        }),
    ...(declared.capabilities === undefined ? {} : { capabilities: declared.capabilities }),
  });
}
