import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

/**
 * Thrown by the view the engine hands to a model or a DSL when it writes into it. A model, a DSL
 * or a `validateParams` that writes into its arguments is not allowed to change what the engine
 * holds: the write is refused with this error, and the rule it belongs to is excluded.
 */
export class FrozenViewWriteError extends PPEError {
  constructor(readonly key: string) {
    super(`wrote to its input: ${key}`, 'FROZEN_VIEW_WRITE');
    this.name = 'FrozenViewWriteError';
  }
}

markEngineError(FrozenViewWriteError);
