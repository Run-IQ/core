import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import { makeRule, makeInput, StubModel, StubPlugin } from '../helpers.js';

// A DSL evaluator that returns a promise disguised as boolean.
// PluginSandbox.withTimeout wraps fn() via Promise.resolve().then(() => fn()),
// so returning a promise works and allows the timeout race to fire.
const slowDslEvaluator: DSLEvaluator = {
  dsl: 'slow-dsl',
  version: '1.0.0',
  evaluate: (_expression: unknown, _context: Record<string, unknown>): boolean => {
    return new Promise((resolve) => setTimeout(resolve, 300)) as unknown as boolean;
  },
};

describe('DSL timeout integration', () => {
  it('skips rule with CONDITION_TIMEOUT when DSL exceeds timeout', async () => {
    const model = new StubModel('M', 500);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [slowDslEvaluator],
      strict: false,
      timeout: { dsl: 50, hook: 500 },
    });

    const rule = makeRule({
      id: 'r-slow',
      model: 'M',
      params: {},
      condition: { dsl: 'slow-dsl', value: { always: true } },
    });

    const result = await engine.evaluate([rule], makeInput());

    expect(result.skippedRules).toHaveLength(1);
    expect(result.skippedRules[0]!.reason).toBe('CONDITION_TIMEOUT');
    expect(result.value).toBe(0);
  });

  it('continues evaluating other rules after a timeout', async () => {
    const model = new StubModel('M', 200);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [slowDslEvaluator],
      strict: false,
      timeout: { dsl: 50, hook: 500 },
    });

    const slowRule = makeRule({
      id: 'r-slow',
      model: 'M',
      params: {},
      condition: { dsl: 'slow-dsl', value: {} },
    });

    const normalRule = makeRule({
      id: 'r-normal',
      model: 'M',
      params: {},
    });

    const result = await engine.evaluate([slowRule, normalRule], makeInput());

    expect(result.skippedRules).toHaveLength(1);
    expect(result.skippedRules[0]!.rule.id).toBe('r-slow');
    expect(result.appliedRules).toHaveLength(1);
    expect(result.appliedRules[0]!.id).toBe('r-normal');
    expect(result.value).toBe(200);
  });
});
