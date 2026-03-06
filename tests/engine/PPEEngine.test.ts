import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import {
  makeRule,
  makeInput,
  StubModel,
  StubPlugin,
  StubDSL,
  InMemorySnapshotAdapter,
} from '../helpers.js';

describe('PPEEngine', () => {
  it('evaluates rules end-to-end', async () => {
    const model = new StubModel('M', 250);
    const plugin = new StubPlugin('test', [model]);
    const adapter = new InMemorySnapshotAdapter();

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());

    expect(result.value).toBe(250);
    expect(result.appliedRules).toHaveLength(1);
    expect(result.engineVersion).toBe('0.1.0');
    expect(result.snapshotId).toBeTruthy();
    expect(result.trace.steps).toHaveLength(1);
  });

  it('rejects invalid input', async () => {
    const engine = new PPEEngine({
      plugins: [],
      dsls: [],
      strict: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(engine.evaluate([], {} as any)).rejects.toThrow(ValidationError);
  });

  it('skips rules with checksum mismatch', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: false,
    });

    const rule = { ...makeRule({ id: 'r1', model: 'M', params: { x: 1 } }), checksum: 'bad' };
    const result = await engine.evaluate([rule], makeInput());

    expect(result.value).toBe(0);
    expect(result.skippedRules).toHaveLength(1);
    expect(result.skippedRules[0]!.reason).toBe('CHECKSUM_MISMATCH');
  });

  it('skips rules with unregistered DSL', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: false,
    });

    const rule = makeRule({
      id: 'r1',
      model: 'M',
      params: {},
      condition: { dsl: 'nonexistent', value: {} },
    });

    const result = await engine.evaluate([rule], makeInput());
    expect(result.skippedRules).toHaveLength(1);
    expect(result.skippedRules[0]!.reason).toBe('DSL_NOT_FOUND');
  });

  it('records dslVersions in result', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);
    const dsl = new StubDSL('jsonlogic');

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [dsl],
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());
    expect(result.dslVersions['jsonlogic']).toBe('1.0.0');
  });

  it('handles plugin hook errors gracefully', async () => {
    const model = new StubModel('M', 100);

    const errorPlugin = new StubPlugin('erroring', [model]);
    errorPlugin.beforeEvaluate = () => {
      throw new Error('hook crash');
    };

    const engine = new PPEEngine({
      plugins: [errorPlugin],
      dsls: [],
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());
    // Pipeline should continue despite hook error
    expect(result.value).toBe(100);
    expect(errorPlugin.errors).toHaveLength(1);
  });

  it('supports dryRun mode (no snapshot saved)', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);
    const adapter = new InMemorySnapshotAdapter();

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: true,
      dryRun: true,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());
    expect(result.value).toBe(100);
    // In dryRun, snapshot adapter should not have been called
    expect(await adapter.exists('test-request-001')).toBe(false);
  });
});
