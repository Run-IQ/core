import type { EvaluationInput } from './input.js';
import type { EvaluationResult } from './result.js';
import type { Rule } from './rule.js';
import type { EvaluationTrace } from './trace.js';

export interface Snapshot {
  readonly id: string;
  readonly requestId: string;
  readonly engineVersion: string;
  readonly pluginVersions: Record<string, string>;
  readonly dslVersions: Record<string, string>;
  readonly inputSnapshot: EvaluationInput;
  readonly rulesSnapshot: ReadonlyArray<Rule>;
  readonly result: EvaluationResult;
  readonly trace: EvaluationTrace;
  readonly checksum: string;
  readonly timestamp: Date;
  readonly tenantId: string;
}

export interface ISnapshotAdapter {
  save(snapshot: Snapshot): Promise<string>;
  get(snapshotId: string): Promise<Snapshot>;
  exists(requestId: string): Promise<boolean>;
}
