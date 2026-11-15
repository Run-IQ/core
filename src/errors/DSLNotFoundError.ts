import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

export class DSLNotFoundError extends PPEError {
  constructor(public readonly dslName: string) {
    checkArgs('DSLNotFoundError', [[dslName, 's']]);
    super(`DSL evaluator "${dslName}" not found in DSLRegistry`, 'DSL_NOT_FOUND');
    this.name = 'DSLNotFoundError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, DSLNotFoundError);
  }
}

markEngineError(DSLNotFoundError);
