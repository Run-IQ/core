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
    // The stub of an already seen requestId: nothing evaluated, marked by meta.cached (Task 10
    // replaces the stub by the stored decision, `fromStore`).
    expect(result2).toEqual({
      requestId: 'idempotent-001',
      value: 0,
      outputs: {
        value: { name: 'value', type: 'number', combine: 'sum', value: 0, contributors: [] },
      },
      breakdown: [],
      appliedRules: [],
      skippedRules: [],
      trace: { steps: [], totalDurationMs: 0 },
      diagnostics: [],
      missingFacts: [],
      pluginState: {},
      engineVersion: result1.engineVersion,
      pluginVersions: {},
      dslVersions: {},
      timestamp: result2.timestamp,
      meta: { cached: true },
    });
    expect(result1).not.toHaveProperty('meta');
  });
});
