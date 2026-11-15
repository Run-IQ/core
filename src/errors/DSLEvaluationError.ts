import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';
import { describeFault, faultOf, type PluginFault } from '../engine/pluginPort.js';

export class DSLEvaluationError extends PPEError {
  /** What the evaluator threw, as text (`name`, `message`, `code`), never the object it holds. */
  public readonly originalError: Readonly<PluginFault>;

  constructor(
    public readonly dslName: string,
    originalError: unknown,
  ) {
    const fault = faultOf(originalError);
    super(`DSL "${dslName}" evaluation failed: ${describeFault(fault)}`, 'DSL_EVALUATION_ERROR');
    this.originalError = Object.freeze({ ...fault });
    this.name = 'DSLEvaluationError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    Object.freeze(this);
  }
}

markEngineError(DSLEvaluationError);
