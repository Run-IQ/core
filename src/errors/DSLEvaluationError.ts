import { PPEError } from './PPEError.js';

export class DSLEvaluationError extends PPEError {
  constructor(
    public readonly dslName: string,
    public readonly originalError: unknown,
  ) {
    super(`DSL "${dslName}" evaluation failed: ${String(originalError)}`, 'DSL_EVALUATION_ERROR');
    this.name = 'DSLEvaluationError';
  }
}
