import { PPEError } from './PPEError.js';

export class DSLTimeoutError extends PPEError {
  constructor(
    public readonly dslName: string,
    public readonly timeoutMs: number,
  ) {
    super(`DSL "${dslName}" evaluation timed out after ${timeoutMs}ms`, 'DSL_TIMEOUT');
    this.name = 'DSLTimeoutError';
  }
}
