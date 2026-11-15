import type { ISnapshotAdapter, Snapshot } from '../types/snapshot.js';
import { CallbackError } from '../errors/CallbackError.js';
import { SnapshotFailureError } from '../errors/SnapshotFailureError.js';

export class SnapshotManager {
  constructor(
    private readonly adapter: ISnapshotAdapter | null,
    private readonly strict: boolean,
    private readonly onSnapshotError?: ((error: unknown) => void) | undefined,
  ) {}

  async exists(requestId: string): Promise<boolean> {
    if (!this.adapter) return false;
    // A failing existence check cannot say whether the request was seen: the evaluation fails, with
    // the adapter's failure as bounded text, never the object the adapter threw.
    try {
      return await this.adapter.exists(requestId);
    } catch (error) {
      throw new SnapshotFailureError(error, 'exists');
    }
  }

  async save(snapshot: Snapshot): Promise<string> {
    if (!this.adapter) {
      return snapshot.id;
    }

    try {
      return await this.adapter.save(snapshot);
    } catch (error) {
      if (this.strict) {
        throw new SnapshotFailureError(error);
      }
      // Lenient mode: notify via callback if provided, then return snapshot id
      if (this.onSnapshotError) {
        try {
          this.onSnapshotError(error);
        } catch (thrown) {
          throw new CallbackError('onSnapshotError', thrown);
        }
      }
      return snapshot.id;
    }
  }
}
