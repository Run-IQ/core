import { PPEError } from './PPEError.js';

export class ModelNotFoundError extends PPEError {
  constructor(public readonly modelName: string) {
    super(`Model "${modelName}" not found in ModelRegistry`, 'MODEL_NOT_FOUND');
    this.name = 'ModelNotFoundError';
  }
}
