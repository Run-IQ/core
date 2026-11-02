import type { DSLEvaluator } from '../types/dsl.js';
import { copyDeclaration } from './ModelRegistry.js';

export class DSLRegistry {
  private readonly evaluators = new Map<string, DSLEvaluator>();
  /** The version and capabilities as registered, copied at that moment. */
  private readonly declared = new Map<
    string,
    { readonly version: string; readonly capabilities: DSLEvaluator['capabilities'] }
  >();

  register(evaluator: DSLEvaluator): void {
    const dsl = evaluator.dsl;
    if (this.evaluators.has(dsl)) {
      throw new Error(`DSL evaluator "${dsl}" is already registered`);
    }
    const given: unknown = evaluator.capabilities; // read once
    const capabilities =
      given === undefined
        ? undefined
        : (copyDeclaration(given, dsl, '/capabilities') as DSLEvaluator['capabilities']);
    this.evaluators.set(dsl, evaluator);
    this.declared.set(dsl, { version: evaluator.version, capabilities });
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

  /** A registry fixed at this moment: an evaluator registered later is not seen by it. */
  snapshot(): DSLRegistry {
    const fixed = new DSLRegistry();
    for (const [name, evaluator] of this.evaluators) {
      // justification: `register` sets both maps together.
      const declared = this.declared.get(name) as NonNullable<ReturnType<typeof this.declared.get>>;
      fixed.evaluators.set(name, fixEvaluator(name, evaluator, declared));
    }
    return fixed;
  }
}

/** A frozen record of `evaluator` as it is now: its functions taken once and bound. */
function fixEvaluator(
  dsl: string,
  evaluator: DSLEvaluator,
  declared: { readonly version: string; readonly capabilities: DSLEvaluator['capabilities'] },
): DSLEvaluator {
  const { evaluate, listVariables, compute } = evaluator;
  return Object.freeze({
    dsl,
    version: declared.version,
    evaluate: (expression: unknown, context: Record<string, unknown>) =>
      evaluate.call(evaluator, expression, context),
    ...(listVariables === undefined
      ? {}
      : { listVariables: (expression: unknown) => listVariables.call(evaluator, expression) }),
    ...(compute === undefined
      ? {}
      : {
          compute: (expression: unknown, context: Record<string, unknown>) =>
            compute.call(evaluator, expression, context),
        }),
    ...(declared.capabilities === undefined ? {} : { capabilities: declared.capabilities }),
  });
}
