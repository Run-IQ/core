import { PPEError } from './PPEError.js';

/**
 * A decimal the engine handles (a contribution, a short-circuit value, a combined or rounded
 * value of a `decimal` output) spans more than `limit` (1000) digits, from its highest to its
 * lowest position, the units included: the decision is refused rather than returned with a
 * silently rounded amount.
 */
export class DecimalPrecisionError extends PPEError {
  constructor(
    public readonly output: string,
    /** The most digits a decimal may span. */
    public readonly limit: number,
  ) {
    super(
      `Output ${output} holds a decimal spanning more than ${limit} digits: the decision is refused rather than rounded`,
      'DECIMAL_PRECISION',
    );
    this.name = 'DecimalPrecisionError';
  }
}
