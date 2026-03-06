import type { DSLEvaluator } from '../types/dsl.js';
import { DSLTimeoutError } from '../errors/DSLTimeoutError.js';

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
      return await this.withTimeout(() => evaluator.evaluate(expression, context), this.dslTimeout);
    } catch (error) {
      if (error instanceof DSLTimeoutError) {
        throw error;
      }
      throw new DSLTimeoutError(evaluator.dsl, this.dslTimeout);
    }
  }

  private withTimeout<T>(fn: () => T, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DSLTimeoutError('unknown', timeoutMs));
      }, timeoutMs);

      try {
        const result = fn();
        clearTimeout(timer);
        resolve(result);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }
}
