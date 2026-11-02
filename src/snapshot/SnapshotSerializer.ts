import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { EvaluationInput } from '../types/input.js';
import type { UnsealedResult } from '../types/result.js';
import type { Rule } from '../types/rule.js';
import type { EvaluationTrace } from '../types/trace.js';
import type { Snapshot } from '../types/snapshot.js';
import { EngineLimitError } from '../errors/EngineLimitError.js';
import { DEFAULT_LIMITS } from '../limits.js';

export class SnapshotSerializer {
  static serialize(
    input: EvaluationInput,
    rules: ReadonlyArray<Rule>,
    result: UnsealedResult,
    trace: EvaluationTrace,
    engineVersion: string,
    pluginVersions: Record<string, string>,
    dslVersions: Record<string, string>,
    maxRecordLength: number = DEFAULT_LIMITS.maxRecordLength,
  ): Snapshot {
    // Deep immutable copy — structuredClone preserves Date objects (Node 17+)
    const tooLong = (): never => {
      throw new EngineLimitError('maxRecordLength', maxRecordLength, maxRecordLength + 1);
    };
    const clone = <T>(value: T): T => {
      try {
        return structuredClone(value);
      } catch (error) {
        if (error instanceof RangeError) return tooLong();
        throw error;
      }
    };
    const inputSnapshot = clone(input) as EvaluationInput;
    // The rules are the engine's own: deep-frozen, holding no `Date` and nothing that is not plain
    // data, so there is nothing to copy; only the list is new.
    const rulesSnapshot = Object.freeze([...rules]) as unknown as Rule[];
    const resultCopy = clone(result) as UnsealedResult;
    const traceCopy = clone(trace) as EvaluationTrace;

    const id = randomUUID();

    const snapshotWithoutChecksum = {
      id,
      requestId: input.requestId,
      engineVersion,
      pluginVersions: { ...pluginVersions },
      dslVersions: { ...dslVersions },
      inputSnapshot,
      rulesSnapshot,
      result: resultCopy,
      trace: traceCopy,
      timestamp: new Date(),
      tenantId: input.meta.tenantId,
    };

    // SHA-256 checksum of the entire snapshot. Its text is held to `maxRecordLength`; a runtime
    // that cannot build a string that long (`RangeError`) is the same limit, named, never a raw
    // error from the serializer.
    let text: string;
    try {
      text = JSON.stringify(snapshotWithoutChecksum);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return tooLong();
    }
    if (text.length > maxRecordLength) {
      throw new EngineLimitError('maxRecordLength', maxRecordLength, text.length);
    }
    const checksum = createHash('sha256').update(text).digest('hex');

    return {
      ...snapshotWithoutChecksum,
      checksum,
    };
  }
}
