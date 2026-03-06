import { describe, it, expect } from 'vitest';
import { SnapshotManager } from '../../src/snapshot/SnapshotManager.js';
import { SnapshotFailureError } from '../../src/errors/SnapshotFailureError.js';
import { InMemorySnapshotAdapter } from '../helpers.js';
import type { Snapshot } from '../../src/types/snapshot.js';

const dummySnapshot: Snapshot = {
  id: 'snap-1',
  requestId: 'req-1',
  engineVersion: '0.1.0',
  pluginVersions: {},
  dslVersions: {},
  inputSnapshot: { requestId: 'req-1', data: {}, meta: { tenantId: 't' } },
  rulesSnapshot: [],
  result: {
    requestId: 'req-1',
    value: 0,
    breakdown: [],
    appliedRules: [],
    skippedRules: [],
    trace: { steps: [], totalDurationMs: 0 },
    snapshotId: 'snap-1',
    engineVersion: '0.1.0',
    pluginVersions: {},
    dslVersions: {},
    timestamp: new Date(),
  },
  trace: { steps: [], totalDurationMs: 0 },
  checksum: 'abc',
  timestamp: new Date(),
  tenantId: 't',
};

describe('SnapshotManager', () => {
  it('saves snapshot successfully', async () => {
    const adapter = new InMemorySnapshotAdapter();
    const manager = new SnapshotManager(adapter, true);
    const id = await manager.save(dummySnapshot);
    expect(id).toBe('snap-1');
  });

  it('checks existence', async () => {
    const adapter = new InMemorySnapshotAdapter();
    const manager = new SnapshotManager(adapter, true);
    await manager.save(dummySnapshot);
    expect(await manager.exists('req-1')).toBe(true);
    expect(await manager.exists('req-999')).toBe(false);
  });

  it('throws SnapshotFailureError in strict mode on save failure', async () => {
    const adapter = new InMemorySnapshotAdapter();
    adapter.shouldFail = true;
    const manager = new SnapshotManager(adapter, true);
    await expect(manager.save(dummySnapshot)).rejects.toThrow(SnapshotFailureError);
  });

  it('returns id in lenient mode on save failure', async () => {
    const adapter = new InMemorySnapshotAdapter();
    adapter.shouldFail = true;
    const manager = new SnapshotManager(adapter, false);
    const id = await manager.save(dummySnapshot);
    expect(id).toBe('snap-1');
  });

  it('works without adapter (null)', async () => {
    const manager = new SnapshotManager(null, true);
    expect(await manager.exists('any')).toBe(false);
    const id = await manager.save(dummySnapshot);
    expect(id).toBe('snap-1');
  });
});
