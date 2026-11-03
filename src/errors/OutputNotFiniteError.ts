import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

/**
 * The combined value of a number output is not finite (e.g. a sum that overflows): the decision
 * is refused rather than returned with a partial amount.
 */
export class OutputNotFiniteError extends PPEError {
  constructor(
    public readonly output: string,
    /** The ids of the rules whose contributions were combined, by id then version. */
    public readonly contributors: readonly string[],
  ) {
    super(
      `Output ${output} is not a finite number; contributors: ${contributors.join(', ')}`,
      'OUTPUT_NOT_FINITE',
    );
    this.name = 'OutputNotFiniteError';
  }
}

markEngineError(OutputNotFiniteError);
