import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { makeRule, makeInput, StubModel, StubPlugin, InMemorySnapshotAdapter } from '../helpers.js';

describe('SnapshotManager lenient mode (via engine)', () => {
  it('swallows snapshot save error and still returns result', async () => {
    const adapter = new InMemorySnapshotAdapter();
    adapter.shouldFail = true;

    const model = new StubModel('M', 750);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());

    expect(result.value).toBe(750);
    expect(result.appliedRules).toHaveLength(1);
    expect(result.appliedRules[0]!.id).toBe('r1');
  });

  it('returns snapshotId even when adapter fails in lenient mode', async () => {
    const adapter = new InMemorySnapshotAdapter();
    adapter.shouldFail = true;

    const model = new StubModel('M', 300);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());

    // snapshotId should still be set (the serializer generates it before save)
    expect(result.snapshotId).toBeTruthy();
    expect(result.snapshotId).not.toBe('');
  });

  it('does not throw when adapter fails in lenient mode with multiple rules', async () => {
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

    const rules = [
      makeRule({ id: 'r1', model: 'M', priority: 200, params: {} }),
      makeRule({ id: 'r2', model: 'M', priority: 100, params: {} }),
    ];

    const result = await engine.evaluate(rules, makeInput());

    expect(result.value).toBe(200);
    expect(result.appliedRules).toHaveLength(2);
  });
});
