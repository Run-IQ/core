import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

export class PipelineTimeoutError extends PPEError {
  constructor(public readonly timeoutMs: number) {
    checkArgs('PipelineTimeoutError', [[timeoutMs, 'n']]);
    super(`Pipeline evaluation timed out after ${timeoutMs}ms`, 'PIPELINE_TIMEOUT');
    this.name = 'PipelineTimeoutError';
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, PipelineTimeoutError);
  }
}

markEngineError(PipelineTimeoutError);
