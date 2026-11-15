import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

export class ModelNotFoundError extends PPEError {
  constructor(public readonly modelName: string) {
    checkArgs('ModelNotFoundError', [[modelName, 's']]);
    super(`Model "${modelName}" not found in ModelRegistry`, 'MODEL_NOT_FOUND');
    this.name = 'ModelNotFoundError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, ModelNotFoundError);
  }
}

markEngineError(ModelNotFoundError);
