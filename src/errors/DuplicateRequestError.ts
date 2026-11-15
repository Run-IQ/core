import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

/**
 * Thrown by `evaluate` for a `requestId` whose snapshot already exists. Until Task 10 core
 * returns no stored decision; then it returns it with `fromStore: true` and this error is gone.
 */
export class DuplicateRequestError extends PPEError {
  constructor(public readonly requestId: string) {
    checkArgs('DuplicateRequestError', [[requestId, 's']]);
    super(
      `request ${requestId} was already evaluated; its stored decision is returned from Task 10`,
      'DUPLICATE_REQUEST',
    );
    this.name = 'DuplicateRequestError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, DuplicateRequestError);
  }
}

markEngineError(DuplicateRequestError);
