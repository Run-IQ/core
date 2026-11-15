import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

export class DSLEvaluationError extends PPEError {
  constructor(
    public readonly dslName: string,
    public readonly originalError: unknown,
  ) {
    super(`DSL "${dslName}" evaluation failed: ${String(originalError)}`, 'DSL_EVALUATION_ERROR');
    this.name = 'DSLEvaluationError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    Object.freeze(this);
  }
}

markEngineError(DSLEvaluationError);
