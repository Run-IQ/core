import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { PipelineTimeoutError } from '../../src/errors/PipelineTimeoutError.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import { makeRule, makeInput, StubModel, StubPlugin } from '../helpers.js';

// A DSL evaluator that takes a long time to evaluate
const slowDslEvaluator: DSLEvaluator = {
  dsl: 'slow-dsl',
  version: '1.0.0',
  evaluate: (_expression: unknown, _context: Record<string, unknown>): boolean => {
    return new Promise((resolve) => setTimeout(() => resolve(true), 500)) as unknown as boolean;
  },
};

describe('Pipeline-level timeout', () => {
  it('throws PipelineTimeoutError when pipeline exceeds timeout', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [slowDslEvaluator],
      strict: false,
      timeout: { dsl: 5000, hook: 5000, pipeline: 50 },
    });

    const rule = makeRule({
      id: 'r1',
      model: 'M',
      params: {},
      condition: { dsl: 'slow-dsl', value: { always: true } },
    });

    await expect(engine.evaluate([rule], makeInput())).rejects.toThrow(PipelineTimeoutError);
  });

  it('succeeds when pipeline completes within timeout', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: false,
      timeout: { pipeline: 5000 },
    });

    const rule = makeRule({ id: 'r1', model: 'M', params: {} });
    const result = await engine.evaluate([rule], makeInput());

    expect(result.value).toBe(100);
    expect(result.appliedRules).toHaveLength(1);
  });

  it('works without pipeline timeout configured', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: false,
    });

    const rule = makeRule({ id: 'r1', model: 'M', params: {} });
    const result = await engine.evaluate([rule], makeInput());

    expect(result.value).toBe(100);
  });
});
