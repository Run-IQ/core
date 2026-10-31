import { PPEError } from './PPEError.js';

/**
 * The exact sum of a `decimal` output needs more significant digits than the engine computes
 * (`limit`, 1000): the decision is refused rather than returned with a silently rounded amount.
 */
export class DecimalPrecisionError extends PPEError {
  constructor(
    public readonly output: string,
    /** The most significant digits an exact sum may have. */
    public readonly limit: number,
  ) {
    super(
      `Output ${output} needs more than ${limit} significant digits: the exact sum is refused rather than rounded`,
      'DECIMAL_PRECISION',
    );
    this.name = 'DecimalPrecisionError';
  }
}
