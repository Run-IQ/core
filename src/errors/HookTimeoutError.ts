import { PPEError } from './PPEError.js';

/** A plugin hook did not settle within `timeout.hook`. */
export class HookTimeoutError extends PPEError {
  constructor(
    public readonly pluginName: string,
    public readonly hook: 'beforeEvaluate' | 'afterEvaluate',
    public readonly timeoutMs: number,
  ) {
    super(`plugin ${pluginName} hook ${hook} timed out after ${timeoutMs} ms`, 'HOOK_TIMEOUT');
    this.name = 'HookTimeoutError';
  }
}
