import { PPEError } from './PPEError.js';

export class SnapshotFailureError extends PPEError {
  constructor(public readonly cause_: unknown) {
    super('Snapshot save failed in strict mode', 'SNAPSHOT_FAILURE');
    this.name = 'SnapshotFailureError';
  }
}
