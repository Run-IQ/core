import { PPEError } from './PPEError.js';

/**
 * Thrown by `evaluate` for a `requestId` whose snapshot already exists. Until Task 10 core
 * returns no stored decision; then it returns it with `fromStore: true` and this error is gone.
 */
export class DuplicateRequestError extends PPEError {
  constructor(public readonly requestId: string) {
    super(
      `request ${requestId} was already evaluated; its stored decision is returned from Task 10`,
      'DUPLICATE_REQUEST',
    );
    this.name = 'DuplicateRequestError';
  }
}
