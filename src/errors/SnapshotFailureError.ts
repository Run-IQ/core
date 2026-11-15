import { faultOf } from '../engine/pluginPort.js';
import { PPEError } from './PPEError.js';
import { markEngineError } from './engineError.js';

export class SnapshotFailureError extends PPEError {
  constructor(original: unknown, operation: 'save' | 'exists' = 'save') {
    super(
      operation === 'save' ? 'Snapshot save failed in strict mode' : 'Snapshot exists check failed',
      'SNAPSHOT_FAILURE',
    );
    this.name = 'SnapshotFailureError';
    // The adapter's error is held as bounded text (name, message, code), never as the object.
    this.cause = Object.freeze({ ...faultOf(original) });
    // Frozen at creation: what the caller receives cannot be changed (B74).
    Object.freeze(this);
  }
}

markEngineError(SnapshotFailureError);
