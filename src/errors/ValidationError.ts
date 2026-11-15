import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

/** The most reasons a `ValidationError` lists; the rest are counted. */
export const MAX_REASONS = 50;

export class ValidationError extends PPEError {
  public readonly reasons: readonly string[];

  constructor(message: string, reasons: readonly string[]) {
    checkArgs('ValidationError', [
      [message, 's'],
      [reasons, 'S'],
    ]);
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    // Frozen at creation, the list included: what the caller receives cannot be changed (B74).
    // Bounded: the first MAX_REASONS, then how many more there were (a 20 000-key input gives a short list).
    this.reasons = Object.freeze(
      reasons.length <= MAX_REASONS
        ? [...reasons]
        : [...reasons.slice(0, MAX_REASONS), `... and ${reasons.length - MAX_REASONS} more`],
    );
    sealEngineError(this, new.target, ValidationError);
  }
}

markEngineError(ValidationError);
