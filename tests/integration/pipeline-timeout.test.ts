import { afterEach, describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { PipelineTimeoutError } from '../../src/errors/PipelineTimeoutError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import type { PPEPlugin } from '../../src/types/plugin.js';
import { makeRule, makeInput, StubModel, StubPlugin } from '../helpers.js';

// A plugin whose hook takes a long time (a hook may be async; a DSL may not).
const slowPlugin: PPEPlugin = {
  name: 'slow',
  version: '1.0.0',
  onInit: () => undefined,
  beforeEvaluate: async (input, rules) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { input, rules };
  },
};

describe('Pipeline-level timeout', () => {
  it('throws PipelineTimeoutError when pipeline exceeds timeout', async () => {
    const model = new StubModel('m', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin, slowPlugin],
      dsls: [],
      strict: false,
      timeout: { dsl: 5000, hook: 5000, pipeline: 50 },
    });

    const rule = makeRule({ id: 'r1', model: 'm', params: {} });

    await expect(engine.evaluate([rule], makeInput())).rejects.toThrow(PipelineTimeoutError);
  });

  it('succeeds when pipeline completes within timeout', async () => {
    const model = new StubModel('m', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: false,
      timeout: { pipeline: 5000 },
    });

    const rule = makeRule({ id: 'r1', model: 'm', params: {} });
    const result = await engine.evaluate([rule], makeInput());

    expect(result.value).toBe(100);
    expect(result.appliedRules).toHaveLength(1);
  });

  it('works without pipeline timeout configured', async () => {
    const model = new StubModel('m', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: false,
    });

    const rule = makeRule({ id: 'r1', model: 'm', params: {} });
    const result = await engine.evaluate([rule], makeInput());

    expect(result.value).toBe(100);
  });
});

describe('Pipeline timeout timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function engine(): PPEEngine {
    return new PPEEngine({
      plugins: [new StubPlugin('test', [new StubModel('m', 100)])],
      dsls: [],
      strict: false,
      timeout: { pipeline: 5000 },
    });
  }

  it('leaves no timer pending after a successful evaluation', async () => {
    vi.useFakeTimers();
    const result = await engine().evaluate([makeRule({ id: 'r1', model: 'm' })], makeInput());
    expect(result.value).toBe(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending after a failed evaluation', async () => {
    vi.useFakeTimers();
    const invalid = makeInput({ requestId: '' });
    await expect(engine().evaluate([], invalid)).rejects.toThrow(ValidationError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
