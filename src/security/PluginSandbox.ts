import type { DSLEvaluator } from '../types/dsl.js';
import { DSLTimeoutError } from '../errors/DSLTimeoutError.js';
import { DSLEvaluationError } from '../errors/DSLEvaluationError.js';
import { HookTimeoutError } from '../errors/HookTimeoutError.js';
import type { PPEError } from '../errors/PPEError.js';

export class PluginSandbox {
  constructor(
    private readonly hookTimeout: number = 500,
    private readonly dslTimeout: number = 100,
  ) {}

  /** Runs a plugin hook; past the hook timeout, rejects with `HookTimeoutError`. */
  async runHook<T>(
    fn: () => T,
    pluginName: string,
    hook: 'beforeEvaluate' | 'afterEvaluate',
  ): Promise<T> {
    return this.withTimeout(
      fn,
      this.hookTimeout,
      () => new HookTimeoutError(pluginName, hook, this.hookTimeout),
    );
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
        () => new DSLTimeoutError(evaluator.dsl, this.dslTimeout),
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
    timedOut: () => PPEError,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(timedOut());
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
