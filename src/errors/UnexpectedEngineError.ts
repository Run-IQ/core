import { PPEError } from './PPEError.js';
import { describeThrown } from '../utils/values.js';
import { frozenErrorCopy } from '../utils/frozenCopy.js';

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

  /**
   * A throw of plugin code (a model, a DSL) as the engine's own error: `cause` is a deep-frozen
   * copy of what was thrown, never the object the plugin holds, whatever its class.
   */
  static foreign(error: unknown): UnexpectedEngineError {
    return new UnexpectedEngineError(frozenErrorCopy(error));
  }

  /** `error` itself when it is a `PPEError`, else `error` wrapped. */
  static wrap(error: unknown): PPEError {
    try {
      if (error instanceof PPEError) return error;
    } catch {
      // A hostile value (revoked proxy...) whose prototype cannot be read: wrapped below.
    }
    return new UnexpectedEngineError(error);
  }
}
