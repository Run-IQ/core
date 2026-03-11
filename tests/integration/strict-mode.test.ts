import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { SnapshotFailureError } from '../../src/errors/SnapshotFailureError.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { makeRule, makeInput, StubModel, StubPlugin, InMemorySnapshotAdapter } from '../helpers.js';

describe('Strict mode', () => {
  it('throws SnapshotFailureError when save fails in strict mode', async () => {
    const adapter = new InMemorySnapshotAdapter();
    adapter.shouldFail = true;

    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: true,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const input = makeInput({ meta: { tenantId: 'tenant-1', effectiveDate: new Date() } });
    await expect(engine.evaluate(rules, input)).rejects.toThrow(SnapshotFailureError);
  });

  it('returns result when save fails in lenient mode', async () => {
    const adapter = new InMemorySnapshotAdapter();
    adapter.shouldFail = true;

    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());
    expect(result.value).toBe(100);
  });

  it('throws RuleConflictError in strict mode on priority conflict', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: true,
      onConflict: 'throw',
    });

    const rules = [
      makeRule({ id: 'r1', model: 'M', priority: 100, params: {}, dominanceGroup: 'G1' }),
      makeRule({ id: 'r2', model: 'M', priority: 100, params: {}, dominanceGroup: 'G1' }),
    ];
    const input = makeInput({ meta: { tenantId: 'tenant-1', effectiveDate: new Date() } });
    await expect(engine.evaluate(rules, input)).rejects.toThrow(RuleConflictError);
  });
});
