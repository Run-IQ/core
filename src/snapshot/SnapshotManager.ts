import type { ISnapshotAdapter, Snapshot } from '../types/snapshot.js';
import { SnapshotFailureError } from '../errors/SnapshotFailureError.js';

export class SnapshotManager {
  constructor(
    private readonly adapter: ISnapshotAdapter | null,
    private readonly strict: boolean,
  ) {}

  async exists(requestId: string): Promise<boolean> {
    if (!this.adapter) return false;
    return this.adapter.exists(requestId);
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
      // Lenient mode: return snapshot id, log failure silently
      return snapshot.id;
    }
  }
}
