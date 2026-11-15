import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';
import { describeFault, faultOf } from '../engine/pluginPort.js';

/**
 * A callback the caller gave the engine (`onSnapshotError`) threw. The failure is held as bounded
 * text (`name`, `message`, `code`), never as the object the callback threw. Frozen at creation.
 */
export class CallbackError extends PPEError {
  public readonly callback: string;
  override readonly cause: unknown;

  constructor(callback: string, thrown: unknown) {
    const fault = faultOf(thrown);
    super(`callback ${callback} failed: ${describeFault(fault)}`, 'CALLBACK_FAILURE');
    this.name = 'CallbackError';
    this.callback = callback;
    this.cause = Object.freeze({ ...fault });
    Object.freeze(this);
  }
}

markEngineError(CallbackError);
