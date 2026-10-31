import { PPEError } from './PPEError.js';
import { describeThrown } from '../utils/values.js';

/**
 * A thrown value that is not a `PPEError` (a model's `RangeError`, a plugin's `TypeError`...),
 * wrapped so that `PPEPlugin.onError` always receives a `PPEError`. `cause` is the value as it
 * was thrown; the message is its message.
 */
export class UnexpectedEngineError extends PPEError {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(describeThrown(cause), 'UNEXPECTED');
    this.name = 'UnexpectedEngineError';
    this.cause = cause;
  }

  /** `error` itself when it is a `PPEError`, else `error` wrapped. */
  static wrap(error: unknown): PPEError {
    return error instanceof PPEError ? error : new UnexpectedEngineError(error);
  }
}
