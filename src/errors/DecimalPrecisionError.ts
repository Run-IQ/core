import { PPEError } from './PPEError.js';

/**
 * A decimal the engine handles (a contribution, a short-circuit value, a combined or rounded
 * value of a `decimal` output) has more significant digits than `limit` (1000): the decision is
 * refused rather than returned with a silently rounded amount.
 */
export class DecimalPrecisionError extends PPEError {
  constructor(
    public readonly output: string,
    /** The most significant digits a decimal may have. */
    public readonly limit: number,
  ) {
    super(
      `Output ${output} holds a decimal of more than ${limit} significant digits: the decision is refused rather than rounded`,
      'DECIMAL_PRECISION',
    );
    this.name = 'DecimalPrecisionError';
  }
}
