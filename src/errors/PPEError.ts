import { markEngineError } from './engineError.js';
/** The failure of an `onError` the engine attached to an error: held outside it, so that an error
 * frozen at creation can still carry it. */
const ON_ERROR_FAILURE = new WeakMap<object, Error>();

/** Attaches the failure of an `onError` to the original error the caller receives (B59, B60). */
export function attachOnErrorFailure(error: unknown, failure: Error): void {
  if (typeof error === 'object' && error !== null && !ON_ERROR_FAILURE.has(error)) {
    ON_ERROR_FAILURE.set(error, failure);
  }
}

export class PPEError extends Error {
  /**
   * The first failure of an `onError` while this error was told to the plugins: a
   * `PluginHookError` with `hook: 'onError'` held as bounded text. The error itself is the original,
   * unchanged: a failing `onError` never replaces it and is never its `cause`.
   */
  get onErrorFailure(): Error | undefined {
    return ON_ERROR_FAILURE.get(this);
  }

  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PPEError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

markEngineError(PPEError);
