import { PPEError } from './PPEError.js';
import type { EngineLimits } from '../limits.js';

/**
 * Thrown when an evaluation passes one of `EngineLimits`, before or during it: never a
 * truncation, and nothing is recorded (D-26).
 */
export class EngineLimitError extends PPEError {
  constructor(
    public readonly limit: keyof EngineLimits,
    public readonly max: number,
    public readonly actual: number,
    /** Where the bound was passed, when it is a place in the data (`/data/text`). */
    public readonly pointer?: string,
  ) {
    super(
      `engine limit ${limit} exceeded: ${actual} > ${max}${pointer === undefined ? '' : ` at ${pointer}`}`,
      'ENGINE_LIMIT',
    );
    this.name = 'EngineLimitError';
  }
}
