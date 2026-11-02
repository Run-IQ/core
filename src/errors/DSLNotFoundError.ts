import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

export class DSLNotFoundError extends PPEError {
  constructor(public readonly dslName: string) {
    super(`DSL evaluator "${dslName}" not found in DSLRegistry`, 'DSL_NOT_FOUND');
    this.name = 'DSLNotFoundError';
  }
}

markEngineError(DSLNotFoundError);
