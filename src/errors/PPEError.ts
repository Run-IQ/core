import { clipText } from '../utils/weight.js';
import { markEngineError, sealEngineError } from './engineError.js';
/**
 * The failures of the `onError` hooks the engine attached to an error: held outside it, so that an
 * error frozen at creation can still carry them.
 */
const ON_ERROR_FAILURES = new WeakMap<object, Error[]>();

/** Attaches a failure of an `onError` to the original error the caller receives (B59, B60). */
export function attachOnErrorFailure(error: unknown, failure: Error): void {
  if (typeof error !== 'object' || error === null) return;
  const held = ON_ERROR_FAILURES.get(error);
  if (held === undefined) ON_ERROR_FAILURES.set(error, [failure]);
  else held.push(failure);
}

/** The most characters any engine error message holds (code points, then the marker). */
export const MAX_MESSAGE = 2048;

export class PPEError extends Error {
  /**
   * Every failure of an `onError` while this error was told to the plugins, in plugin order: each a
   * `PluginHookError` with `hook: 'onError'` held as bounded text. The list is frozen and empty
   * when none failed. The error itself is the original, unchanged: a failing `onError` never
   * replaces it, is never its `cause`, and is never dropped.
   */
  get onErrorFailures(): readonly Error[] {
    return Object.freeze([...(ON_ERROR_FAILURES.get(this) ?? [])]);
  }

  constructor(
    message: string,
    public readonly code: string,
  ) {
    // Anything that is not a string is shown as a fixed text (no conversion of it is ever run), and
    // every message is held to one declared bound, whatever list or key it was built from (B92).
    super(
      typeof message === 'string'
        ? clipText(message, MAX_MESSAGE, '... [clipped]')
        : 'invalid error message',
    );
    // The code is a string too (a fixed code otherwise).
    // eslint-disable-next-line no-useless-assignment -- the parameter property is assigned from it
    if (typeof code !== 'string') code = 'INVALID_ARGUMENT';
    this.name = 'PPEError';
    Object.setPrototypeOf(this, new.target.prototype);
    // A subclass freezes itself once its own fields are set; a bare PPEError is complete here (B74).
    if (new.target === PPEError) sealEngineError(this, new.target, PPEError);
  }
}

markEngineError(PPEError);
