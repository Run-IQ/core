import type { DSLEvaluator } from '../types/dsl.js';
import { DSLTimeoutError } from '../errors/DSLTimeoutError.js';
import { DSLEvaluationError } from '../errors/DSLEvaluationError.js';

export class PluginSandbox {
  constructor(
    private readonly hookTimeout: number = 500,
    private readonly dslTimeout: number = 100,
  ) {}

  async runHook<T>(fn: () => T, _pluginName: string): Promise<T> {
    return this.withTimeout(fn, this.hookTimeout);
  }

  async runDSL(
    evaluator: DSLEvaluator,
    expression: unknown,
    context: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      return await this.withTimeout(
        () => evaluator.evaluate(expression, context),
        this.dslTimeout,
        evaluator.dsl,
      );
    } catch (error) {
      if (error instanceof DSLTimeoutError) {
        throw error;
      }
      throw new DSLEvaluationError(evaluator.dsl, error);
    }
  }

  private withTimeout<T>(
    fn: () => T | Promise<T>,
    timeoutMs: number,
    label = 'unknown',
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DSLTimeoutError(label, timeoutMs));
      }, timeoutMs);

      Promise.resolve()
        .then(() => fn())
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
