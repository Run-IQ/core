import type { DSLEvaluator } from '../types/dsl.js';

export class DSLRegistry {
  private readonly evaluators = new Map<string, DSLEvaluator>();

  register(evaluator: DSLEvaluator): void {
    if (this.evaluators.has(evaluator.dsl)) {
      throw new Error(`DSL evaluator "${evaluator.dsl}" is already registered`);
    }
    this.evaluators.set(evaluator.dsl, evaluator);
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
    for (const [name, evaluator] of this.evaluators)
      fixed.evaluators.set(name, fixEvaluator(evaluator));
    return fixed;
  }
}

/** A frozen record of `evaluator` as it is now: its functions taken once and bound. */
function fixEvaluator(evaluator: DSLEvaluator): DSLEvaluator {
  const { evaluate, listVariables, compute } = evaluator;
  return Object.freeze({
    dsl: evaluator.dsl,
    version: evaluator.version,
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
    ...(evaluator.capabilities === undefined ? {} : { capabilities: evaluator.capabilities }),
  });
}
