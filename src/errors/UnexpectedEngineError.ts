import { PPEError } from './PPEError.js';
import { describeThrown } from '../utils/values.js';
import { describeFault, faultOf, isPluginFault } from '../engine/pluginPort.js';
import { markEngineError } from './engineError.js';

/**
 * A thrown value that is not a `PPEError` (a model's `RangeError`, a plugin's `TypeError`...),
 * wrapped so that `PPEPlugin.onError` always receives a `PPEError`. `cause` is the value as it
 * was thrown; the message is its message.
 */
export class UnexpectedEngineError extends PPEError {
  override readonly cause: unknown;

  constructor(cause: unknown, message?: string) {
    super(message ?? describeThrown(cause), 'UNEXPECTED');
    this.name = 'UnexpectedEngineError';
    this.cause = cause;
  }

  /**
   * A throw of plugin code (a model, a DSL) as the engine's own error: whatever its class or brand,
   * it is held as text (`name`, `message` and a `code`, each read once and cut), never as the object
   * the plugin holds or a copy of it.
   */
  static foreign(error: unknown): UnexpectedEngineError {
    const fault = isPluginFault(error) ? error.fault : faultOf(error);
    return new UnexpectedEngineError(Object.freeze({ ...fault }), describeFault(fault));
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

markEngineError(UnexpectedEngineError);
