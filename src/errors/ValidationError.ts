import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

export class ValidationError extends PPEError {
  public readonly reasons: readonly string[];

  constructor(message: string, reasons: readonly string[]) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    // Frozen at creation, the list included: what the caller receives cannot be changed (B74).
    this.reasons = Object.freeze([...reasons]);
    Object.freeze(this);
  }
}

markEngineError(ValidationError);
