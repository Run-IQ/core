import { PPEError } from './PPEError.js';
import { num, oneOf, optStr } from './args.js';
import { DEFAULT_LIMITS } from '../limits.js';
import type { EngineLimits } from '../limits.js';
import { isEngineErrorNamed, markEngineError, sealEngineError } from './engineError.js';
import { raised } from '../engine/trust.js';
import { clipText } from '../utils/weight.js';

/** Characters of a pointer shown in a message (spec cuts its issue text at 1 024). */
const MAX_POINTER_TEXT = 1024;

/**
 * Thrown when an evaluation passes one of `EngineLimits`, before or during it: never a
 * truncation, and nothing is recorded (D-26).
 */
export class EngineLimitError extends PPEError {
  /** Where the bound was passed, when it is a place in the data (`/data/text`), cut at 1 024. */
  public readonly pointer: string | undefined;
  /**
   * Where a bound of the whole evaluation was passed when plugin code handed over the value:
   * `model:<name>`, `dsl:<name>` or `validateParams:<model>`. Absent for the caller's own data.
   */
  public readonly source: string | undefined;

  constructor(
    public readonly limit: keyof EngineLimits,
    public readonly max: number,
    public readonly actual: number,
    /** Where the bound was passed, when it is a place in the data (`/data/text`). */
    pointer?: string,
    source?: string,
  ) {
    limit = oneOf(
      'EngineLimitError',
      0,
      limit,
      Object.keys(DEFAULT_LIMITS) as Array<keyof EngineLimits>,
    );
    max = num('EngineLimitError', 1, max);
    actual = num('EngineLimitError', 2, actual);
    pointer = optStr('EngineLimitError', 3, pointer);
    source = optStr('EngineLimitError', 4, source);
    // A pointer can be as long as the key that is refused: it is cut on a code point, with the
    // visible marker, as spec cuts its issue text (B92).
    const shown =
      pointer === undefined ? pointer : clipText(pointer, MAX_POINTER_TEXT, '... [clipped]');
    super(
      `engine limit ${limit} exceeded: ${actual} > ${max}${shown === undefined ? '' : ` at ${shown}`}${source === undefined ? '' : ` (returned by ${source})`}`,
      'ENGINE_LIMIT',
    );
    this.pointer = shown;
    this.source = source;
    this.name = 'EngineLimitError';
    // Frozen at creation (B74), like every error the caller receives.
    sealEngineError(this, new.target, EngineLimitError);
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
  return isEngineErrorNamed(value, 'EngineLimitError');
}

/**
 * The same limit, attributed to the plugin value that broke it (`model:<name>`, `dsl:<name>`,
 * `validateParams:<model>`): a bound of the whole evaluation passed while reading what a model, a
 * DSL or a `validateParams` returned always names where it came from (B75).
 */
export function attributeLimit(error: EngineLimitError, source: string): EngineLimitError {
  return Object.freeze(
    raised(new EngineLimitError(error.limit, error.max, error.actual, error.pointer, source)),
  );
}
