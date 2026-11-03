import { PPEError } from './PPEError.js';
import type { EngineLimits } from '../limits.js';
import { markEngineError } from './engineError.js';
import { raised } from '../engine/trust.js';

/** Characters of a pointer shown in a message (spec cuts its issue text at 1 024). */
const MAX_POINTER_TEXT = 1024;

/**
 * Thrown when an evaluation passes one of `EngineLimits`, before or during it: never a
 * truncation, and nothing is recorded (D-26).
 */
export class EngineLimitError extends PPEError {
  /** Where the bound was passed, when it is a place in the data (`/data/text`), cut at 1 024. */
  public readonly pointer: string | undefined;

  constructor(
    public readonly limit: keyof EngineLimits,
    public readonly max: number,
    public readonly actual: number,
    /** Where the bound was passed, when it is a place in the data (`/data/text`). */
    pointer?: string,
  ) {
    // A pointer can be as long as the key that is refused: it is cut, as spec cuts its issue text.
    const shown =
      pointer === undefined || pointer.length <= MAX_POINTER_TEXT
        ? pointer
        : `${pointer.slice(0, MAX_POINTER_TEXT)}... (${pointer.length} characters)`;
    super(
      `engine limit ${limit} exceeded: ${actual} > ${max}${shown === undefined ? '' : ` at ${shown}`}`,
      'ENGINE_LIMIT',
    );
    this.pointer = shown;
    this.name = 'EngineLimitError';
  }
}

markEngineError(EngineLimitError);

/**
 * Raises a limit error, frozen at creation. A limit is the engine's own only where the engine
 * itself checks it, after a plugin's call has returned, on what the reader read; an
 * `EngineLimitError` that comes out of a plugin frame is a fault of the plugin, whatever it says.
 */
export function raiseLimit(
  limit: keyof EngineLimits,
  max: number,
  actual: number,
  pointer?: string,
): EngineLimitError {
  return Object.freeze(raised(new EngineLimitError(limit, max, actual, pointer)));
}

/** True for a limit error. Only code that no plugin frame sits under asks. */
export function isRaisedLimit(value: unknown): value is EngineLimitError {
  return value instanceof EngineLimitError;
}
