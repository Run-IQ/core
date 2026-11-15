import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { describeFault, faultOf, trustedFault } from '../engine/pluginPort.js';
import { isEngineError, markEngineError, sealEngineError } from './engineError.js';

/**
 * A thrown value that is not a `PPEError` (a model's `RangeError`, a plugin's `TypeError`...),
 * wrapped so that `PPEPlugin.onError` always receives a `PPEError`. `cause` is the text of what
 * was thrown (`name`, `message` and a string `code`, each read once and cut on a code point), never
 * the object a plugin holds; the message is that text's message. The error is frozen at creation.
 */
export class UnexpectedEngineError extends PPEError {
  override readonly cause: unknown;

  constructor(cause: unknown, message?: string) {
    checkArgs('UnexpectedEngineError', [
      [cause, '*'],
      [message, 's?'],
    ]);
    // Only text is read from a foreign thrown value (own data strings, bounded): none of its
    // conversion code (`toString`, `Symbol.toPrimitive`) is ever run.
    const engine = isEngineError(cause);
    const fault = engine ? undefined : (trustedFault(cause) ?? faultOf(cause));
    super(
      message ?? (fault === undefined ? (cause as PPEError).message : describeFault(fault)),
      'UNEXPECTED',
    );
    this.name = 'UnexpectedEngineError';
    this.cause = fault === undefined ? cause : Object.freeze({ ...fault });
    // Frozen at creation (B74): the cause is the text of a fault, or a frozen engine error.
    sealEngineError(this, new.target, UnexpectedEngineError);
  }

  /**
   * A throw of plugin code (a model, a DSL) as the engine's own error: whatever its class or brand,
   * it is held as text (`name`, `message` and a `code`, each read once and cut), never as the object
   * the plugin holds or a copy of it.
   */
  static foreign(error: unknown): UnexpectedEngineError {
    const fault = trustedFault(error) ?? faultOf(error);
    return new UnexpectedEngineError(Object.freeze({ ...fault }), describeFault(fault));
  }

  /**
   * `error` itself when the engine created it (by identity, never by `instanceof`: a caller's
   * subclass of `PPEError` is not the engine's), else `error` wrapped, holding its text only.
   */
  static wrap(error: unknown): PPEError {
    if (isEngineError(error)) return error as PPEError;
    return new UnexpectedEngineError(error);
  }
}

markEngineError(UnexpectedEngineError);
