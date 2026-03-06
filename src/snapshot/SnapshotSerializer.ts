import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { EvaluationInput } from '../types/input.js';
import type { EvaluationResult } from '../types/result.js';
import type { Rule } from '../types/rule.js';
import type { EvaluationTrace } from '../types/trace.js';
import type { Snapshot } from '../types/snapshot.js';

export class SnapshotSerializer {
  static serialize(
    input: EvaluationInput,
    rules: ReadonlyArray<Rule>,
    result: EvaluationResult,
    trace: EvaluationTrace,
    engineVersion: string,
    pluginVersions: Record<string, string>,
    dslVersions: Record<string, string>,
  ): Snapshot {
    // Deep immutable copy
    const inputSnapshot = JSON.parse(JSON.stringify(input)) as EvaluationInput;
    const rulesSnapshot = JSON.parse(JSON.stringify(rules)) as Rule[];
    const resultCopy = JSON.parse(JSON.stringify(result)) as EvaluationResult;
    const traceCopy = JSON.parse(JSON.stringify(trace)) as EvaluationTrace;

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

    // SHA-256 checksum of the entire snapshot
    const checksum = createHash('sha256')
      .update(JSON.stringify(snapshotWithoutChecksum))
      .digest('hex');

    return {
      ...snapshotWithoutChecksum,
      checksum,
    };
  }
}
