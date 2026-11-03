import { PPEError } from './PPEError.js';
import type { EngineLimits } from '../limits.js';
import { markEngineError } from './engineError.js';

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

/** The limit errors the engine raised itself: a brand a plugin cannot set (the set is private). */
const RAISED = new WeakSet<object>();

/**
 * Raises a limit error. The engine tells the errors it raised from an `EngineLimitError` a plugin
 * built (the class is exported) by this brand, never by class.
 */
export function raiseLimit(
  limit: keyof EngineLimits,
  max: number,
  actual: number,
  pointer?: string,
): EngineLimitError {
  const error = new EngineLimitError(limit, max, actual, pointer);
  RAISED.add(error);
  return error;
}

/** True for a limit error the engine raised itself. */
export function isRaisedLimit(value: unknown): value is EngineLimitError {
  return typeof value === 'object' && value !== null && RAISED.has(value);
}
