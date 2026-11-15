import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

/** A plugin hook did not settle within `timeout.hook`. */
export class HookTimeoutError extends PPEError {
  constructor(
    public readonly pluginName: string,
    public readonly hook: 'beforeEvaluate' | 'afterEvaluate',
    public readonly timeoutMs: number,
  ) {
    checkArgs('HookTimeoutError', [
      [pluginName, 's'],
      [hook, 's'],
      [timeoutMs, 'n'],
    ]);
    super(`plugin ${pluginName} hook ${hook} timed out after ${timeoutMs} ms`, 'HOOK_TIMEOUT');
    this.name = 'HookTimeoutError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, HookTimeoutError);
  }
}

markEngineError(HookTimeoutError);
