import type { DSLEvaluator } from '../types/dsl.js';
import { DSLEvaluationError } from '../errors/DSLEvaluationError.js';
import { HookTimeoutError } from '../errors/HookTimeoutError.js';
import type { PPEError } from '../errors/PPEError.js';

export class PluginSandbox {
  constructor(
    private readonly hookTimeout: number = 500,
    private readonly dslTimeout: number = 100,
  ) {}

  /**
   * Runs a plugin hook; past the hook timeout, rejects with `HookTimeoutError`. When `signal`
   * aborts first, rejects with its reason and clears the timeout timer at once.
   */
  async runHook<T>(
    fn: () => T,
    pluginName: string,
    hook: 'beforeEvaluate' | 'afterEvaluate',
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withTimeout(
      fn,
      this.hookTimeout,
      () => new HookTimeoutError(pluginName, hook, this.hookTimeout),
      signal,
    );
  }

  /**
   * Runs a DSL evaluator, whose contract is synchronous: the engine does not wait for it (a
   * promise it returns is a breach of the port, handled there) and no timer can interrupt it. The
   * answer comes back in a box (`{ answer }`): a promise resolved with a value a plugin made would
   * read its `then`, outside the port. Whatever it throws, a `DSLTimeoutError` a plugin built
   * included, is a failure of the evaluator.
   */
  async runDSL(
    evaluator: DSLEvaluator,
    expression: unknown,
    context: Record<string, unknown>,
  ): Promise<{ answer: unknown }> {
    try {
      return { answer: evaluator.evaluate(expression, context) };
    } catch (error) {
      throw new DSLEvaluationError(evaluator.dsl, error);
    }
  }

  private withTimeout<T>(
    fn: () => T | Promise<T>,
    timeoutMs: number,
    timedOut: () => PPEError,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle();
        reject(timedOut());
      }, timeoutMs);
      const onAbort = (): void => {
        settle();
        reject(signal?.reason);
      };
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      Promise.resolve()
        .then(() => fn())
        .then((result) => {
          settle();
          resolve(result);
        })
        .catch((error: unknown) => {
          settle();
          reject(error);
        });
    });
  }
}
