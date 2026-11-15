import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

export class DSLTimeoutError extends PPEError {
  constructor(
    public readonly dslName: string,
    public readonly timeoutMs: number,
  ) {
    checkArgs('DSLTimeoutError', [
      [dslName, 's'],
      [timeoutMs, 'n'],
    ]);
    super(`DSL "${dslName}" evaluation timed out after ${timeoutMs}ms`, 'DSL_TIMEOUT');
    this.name = 'DSLTimeoutError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, DSLTimeoutError);
  }
}

markEngineError(DSLTimeoutError);
