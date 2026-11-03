import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import { makeRule, makeInput, StubModel, StubPlugin } from '../helpers.js';

// The contract of a DSL evaluator is synchronous (`evaluate` returns a boolean): a promise is a
// breach, never awaited, and its rejection is handled. A DSL that is slow is the sandbox's matter
// (phase 3): the engine does not wait for it.
let rejections: unknown[] = [];
const onRejection = (reason: unknown): void => {
  rejections.push(reason);
};
beforeEach(() => {
  rejections = [];
  process.on('unhandledRejection', onRejection);
});
afterEach(() => {
  process.off('unhandledRejection', onRejection);
});

const promising: DSLEvaluator = {
  dsl: 'slow-dsl',
  version: '1.0.0',
  evaluate: (): boolean => {
    return new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('late')), 20),
    ) as never;
  },
};

describe('a DSL that returns a promise', () => {
  it('is excluded as DSL_ERROR, naming the breach, and its rejection is handled', async () => {
    const engine = new PPEEngine({
      plugins: [new StubPlugin('test', [new StubModel('M', 500)])],
      dsls: [promising],
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
    expect(result.skippedRules[0]?.reason).toBe('DSL_ERROR');
    expect(result.skippedRules[0]?.detail).toContain('returned a promise');
    expect(result.value).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(rejections).toEqual([]); // the late rejection was handled
  });

  it('continues evaluating other rules', async () => {
    const engine = new PPEEngine({
      plugins: [new StubPlugin('test', [new StubModel('M', 200)])],
      dsls: [promising],
      strict: false,
      timeout: { dsl: 50, hook: 500 },
    });
    const slowRule = makeRule({
      id: 'r-slow',
      model: 'M',
      params: {},
      condition: { dsl: 'slow-dsl', value: {} },
    });
    const normalRule = makeRule({ id: 'r-normal', model: 'M', params: {} });
    const result = await engine.evaluate([slowRule, normalRule], makeInput());
    expect(result.skippedRules.map((skip) => [skip.rule.id, skip.reason])).toEqual([
      ['r-slow', 'DSL_ERROR'],
    ]);
    expect(result.appliedRules.map((rule) => rule.id)).toEqual(['r-normal']);
    expect(result.value).toBe(200);
  });
});
