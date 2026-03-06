import { describe, it, expect } from 'vitest';
import { SnapshotSerializer } from '../../src/snapshot/SnapshotSerializer.js';
import { makeInput } from '../helpers.js';
import type { EvaluationResult } from '../../src/types/result.js';
import type { EvaluationTrace } from '../../src/types/trace.js';

describe('SnapshotSerializer', () => {
  const input = makeInput();
  const result: EvaluationResult = {
    requestId: 'req-1',
    value: 500,
    breakdown: [],
    appliedRules: [],
    skippedRules: [],
    trace: { steps: [], totalDurationMs: 0 },
    snapshotId: '',
    engineVersion: '0.1.0',
    pluginVersions: {},
    dslVersions: {},
    timestamp: new Date(),
  };
  const trace: EvaluationTrace = { steps: [], totalDurationMs: 0 };

  it('creates a snapshot with checksum', () => {
    const snapshot = SnapshotSerializer.serialize(input, [], result, trace, '0.1.0', {}, {});
    expect(snapshot.checksum).toBeTruthy();
    expect(snapshot.requestId).toBe('test-request-001');
    expect(snapshot.tenantId).toBe('tenant-1');
    expect(snapshot.id).toBeTruthy();
  });

  it('creates deep immutable copies', () => {
    const mutableInput = { ...input, data: { amount: 999 } };
    const snapshot = SnapshotSerializer.serialize(mutableInput, [], result, trace, '0.1.0', {}, {});
    mutableInput.data.amount = 0;
    expect((snapshot.inputSnapshot.data as Record<string, unknown>)['amount']).toBe(999);
  });

  it('includes dslVersions', () => {
    const snapshot = SnapshotSerializer.serialize(
      input,
      [],
      result,
      trace,
      '0.1.0',
      {},
      { jsonlogic: '1.0.0' },
    );
    expect(snapshot.dslVersions['jsonlogic']).toBe('1.0.0');
  });
});
