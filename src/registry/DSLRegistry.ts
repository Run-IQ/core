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

  getAll(): ReadonlyMap<string, DSLEvaluator> {
    return this.evaluators;
  }
}
