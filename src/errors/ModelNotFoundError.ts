import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

export class ModelNotFoundError extends PPEError {
  constructor(public readonly modelName: string) {
    super(`Model "${modelName}" not found in ModelRegistry`, 'MODEL_NOT_FOUND');
    this.name = 'ModelNotFoundError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    Object.freeze(this);
  }
}

markEngineError(ModelNotFoundError);
