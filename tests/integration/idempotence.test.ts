import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { makeRule, makeInput, StubModel, StubPlugin, InMemorySnapshotAdapter } from '../helpers.js';

describe('Idempotence', () => {
  it('returns cached result for duplicate requestId', async () => {
    const adapter = new InMemorySnapshotAdapter();
    const model = new StubModel('M', 500);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const input = makeInput({ requestId: 'idempotent-001' });

    // First call
    const result1 = await engine.evaluate(rules, input);
    expect(result1.value).toBe(500);

    // Second call with same requestId
    const result2 = await engine.evaluate(rules, input);
    expect(result2.snapshotId).toBe('cached');
  });
});
