import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

/** A model refused at registration: its output declaration is invalid (`issues` says why). */
export class InvalidModelError extends PPEError {
  constructor(
    public readonly modelName: string,
    public readonly issues: readonly string[],
  ) {
    super(`Model "${modelName}" declares an invalid output: ${issues.join('; ')}`, 'INVALID_MODEL');
    this.name = 'InvalidModelError';
  }
}

markEngineError(InvalidModelError);
