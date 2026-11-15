import { PPEError } from './PPEError.js';
import { num, str } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

export class DSLTimeoutError extends PPEError {
  constructor(
    public readonly dslName: string,
    public readonly timeoutMs: number,
  ) {
    dslName = str('DSLTimeoutError', 0, dslName);
    timeoutMs = num('DSLTimeoutError', 1, timeoutMs);
    super(`DSL "${dslName}" evaluation timed out after ${timeoutMs}ms`, 'DSL_TIMEOUT');
    this.name = 'DSLTimeoutError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, DSLTimeoutError);
  }
}

markEngineError(DSLTimeoutError);
