import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

/** A model refused at registration: its output declaration is invalid (`issues` says why). */
export class InvalidModelError extends PPEError {
  constructor(
    public readonly modelName: string,
    public readonly issues: readonly string[],
  ) {
    checkArgs('InvalidModelError', [
      [modelName, 's'],
      [issues, 'S'],
    ]);
    super(`Model "${modelName}" declares an invalid output: ${issues.join('; ')}`, 'INVALID_MODEL');
    this.name = 'InvalidModelError';
    this.issues = Object.freeze([...issues]);
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, InvalidModelError);
  }
}

markEngineError(InvalidModelError);
