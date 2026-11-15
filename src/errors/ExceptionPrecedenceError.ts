import { PPEError } from './PPEError.js';
import { str } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

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
    // The parameter properties are assigned from these checked values right after `super`.
    // eslint-disable-next-line no-useless-assignment
    inhibitorId = str('ExceptionPrecedenceError', 0, inhibitorId);
    // eslint-disable-next-line no-useless-assignment
    targetId = str('ExceptionPrecedenceError', 1, targetId);
    inhibitor = str('ExceptionPrecedenceError', 2, inhibitor);
    target = str('ExceptionPrecedenceError', 3, target);
    super(
      `Exception precedence conflict: ${inhibitor} inhibits ${target}, which takes precedence and already fired`,
      'EXCEPTION_PRECEDENCE',
    );
    this.name = 'ExceptionPrecedenceError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, ExceptionPrecedenceError);
  }
}

markEngineError(ExceptionPrecedenceError);
