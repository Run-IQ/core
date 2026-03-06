import { PPEError } from './PPEError.js';

export class ValidationError extends PPEError {
  constructor(
    message: string,
    public readonly reasons: readonly string[],
  ) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}
