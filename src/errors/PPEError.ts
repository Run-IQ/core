import { markEngineError } from './engineError.js';
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
    super(message);
    this.name = 'PPEError';
    Object.setPrototypeOf(this, new.target.prototype);
    // A subclass freezes itself once its own fields are set; a bare PPEError is complete here (B74).
    if (new.target === PPEError) Object.freeze(this);
  }
}

markEngineError(PPEError);
