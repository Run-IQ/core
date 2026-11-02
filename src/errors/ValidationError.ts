import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

export class ValidationError extends PPEError {
  constructor(
    message: string,
    public readonly reasons: readonly string[],
  ) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

markEngineError(ValidationError);
