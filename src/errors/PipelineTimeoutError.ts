import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

export class PipelineTimeoutError extends PPEError {
  constructor(public readonly timeoutMs: number) {
    super(`Pipeline evaluation timed out after ${timeoutMs}ms`, 'PIPELINE_TIMEOUT');
    this.name = 'PipelineTimeoutError';
  }
}

markEngineError(PipelineTimeoutError);
