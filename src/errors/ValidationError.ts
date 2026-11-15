import { PPEError } from './PPEError.js';
import { MAX_ARGUMENT_ITEMS, str, strings } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

/** The most reasons a `ValidationError` lists; the rest are counted. */
export const MAX_REASONS = MAX_ARGUMENT_ITEMS;

export class ValidationError extends PPEError {
  public readonly reasons: readonly string[];

  constructor(message: string, reasons: readonly string[]) {
    message = str('ValidationError', 0, message, 1024);
    reasons = strings('ValidationError', 1, reasons);
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    // Frozen at creation, the list included: what the caller receives cannot be changed (B74).
    // Already bounded by `strings`: the first MAX_ARGUMENT_ITEMS, each clipped, then `... and K more`.
    this.reasons = reasons;
    sealEngineError(this, new.target, ValidationError);
  }
}

markEngineError(ValidationError);
