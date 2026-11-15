import type { ISnapshotAdapter, Snapshot } from '../types/snapshot.js';
import { callSync } from '../engine/pluginPort.js';
import { CallbackError } from '../errors/CallbackError.js';
import { SnapshotFailureError } from '../errors/SnapshotFailureError.js';

const typeOfAnswer = (value: unknown): string => (value === null ? 'null' : typeof value);

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
    let answer: unknown;
    try {
      answer = await this.adapter.exists(requestId);
    } catch (error) {
      throw new SnapshotFailureError(error, 'exists');
    }
    // `true` or `false` only: an adapter that forgets its `return` must not switch the protection
    // against duplicate requests off by answering `undefined`.
    if (typeof answer !== 'boolean') {
      throw new SnapshotFailureError(
        new TypeError(`exists must resolve to true or false, not ${typeOfAnswer(answer)}`),
        'exists',
      );
    }
    return answer;
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
          // Synchronous, like the plugin hooks: a thenable it returns is a breach, never awaited,
          // its rejection handled, and the process never sees an unhandled one (AI2).
          callSync(this.onSnapshotError as (...args: never[]) => unknown, undefined, [error]);
        } catch (thrown) {
          throw new CallbackError('onSnapshotError', thrown);
        }
      }
      return snapshot.id;
    }
  }
}
