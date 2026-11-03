import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

/**
 * A rule inhibits a carrier of exceptions that takes precedence over it (higher priority, or
 * equal priority and lower id@version) and has already fired: its exceptions are final, so the
 * inhibition cannot apply.
 */
export class ExceptionPrecedenceError extends PPEError {
  constructor(
    public readonly inhibitorId: string,
    public readonly targetId: string,
    inhibitor: string,
    target: string,
  ) {
    super(
      `Exception precedence conflict: ${inhibitor} inhibits ${target}, which takes precedence and already fired`,
      'EXCEPTION_PRECEDENCE',
    );
    this.name = 'ExceptionPrecedenceError';
  }
}

markEngineError(ExceptionPrecedenceError);
