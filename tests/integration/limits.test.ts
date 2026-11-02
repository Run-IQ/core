import { describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

/** A plugin that registers model M and records every hook call. */
function spyingPlugin(): PPEPlugin & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'spy',
    version: '1.0.0',
    calls,
    onInit(context: PluginContext): void {
      context.modelRegistry.register(new StubModel('M', 10));
    },
    beforeEvaluate(input, rules) {
      calls.push('beforeEvaluate');
      return { input, rules };
    },
    afterEvaluate(_input, result) {
      calls.push('afterEvaluate');
      return result;
    },
  };
}

const engineWith = (plugin: PPEPlugin, config: Partial<PPEEngineConfig> = {}): PPEEngine =>
  new PPEEngine({ plugins: [plugin], dsls: [], strict: false, ...config });

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => undefined,
    (error: unknown) => error,
  );

const rules = (count: number) =>
  Array.from({ length: count }, (_, i) => makeRule({ id: `r${i}`, model: 'M' }));

const nested = (levels: number): Record<string, unknown> => {
  let value: Record<string, unknown> = { leaf: 1 };
  for (let i = 1; i < levels; i++) value = { a: value };
  return value;
};

describe('the bounds of an evaluation (EngineLimits)', () => {
  it('throws EngineLimitError for more rules than maxRules, before any hook, saving nothing', async () => {
    const plugin = spyingPlugin();
    const adapter = new InMemorySnapshotAdapter();
    const engine = engineWith(plugin, { limits: { maxRules: 3 }, snapshot: adapter });
    const error = await failureOf(() => engine.evaluate(rules(4), makeInput()));
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({
      code: 'ENGINE_LIMIT',
      limit: 'maxRules',
      max: 3,
      actual: 4,
      message: 'engine limit maxRules exceeded: 4 > 3',
    });
    expect(plugin.calls).toEqual([]);
    expect(await adapter.exists('test-request-001')).toBe(false);
  });

  it('accepts exactly maxRules rules', async () => {
    const plugin = spyingPlugin();
    const result = await engineWith(plugin, { limits: { maxRules: 3 } }).evaluate(
      rules(3),
      makeInput(),
    );
    expect(result.appliedRules).toHaveLength(3);
    expect(plugin.calls).toEqual(['beforeEvaluate', 'afterEvaluate']);
  });

  it('gives onError the limit error, as for any failed evaluation', async () => {
    const plugin = spyingPlugin();
    const onError = vi.fn();
    const engine = engineWith({ ...plugin, onError }, { limits: { maxRules: 1 } });
    await failureOf(() => engine.evaluate(rules(2), makeInput()));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(EngineLimitError);
  });

  it('holds the input to maxInputDepth (128 by default): 128 levels pass, 129 throw', async () => {
    expect(DEFAULT_LIMITS.maxInputDepth).toBe(128);
    const plugin = spyingPlugin();
    const engine = engineWith(plugin);
    await engine.evaluate(rules(1), makeInput({ data: nested(128), requestId: 'ok' }));
    const error = await failureOf(() =>
      engine.evaluate(rules(1), makeInput({ data: nested(129), requestId: 'too-deep' })),
    );
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxInputDepth', max: 128, actual: 129 });
    expect(plugin.calls).toEqual(['beforeEvaluate', 'afterEvaluate']);
  });

  it('holds the input to maxInputLeaves', async () => {
    // The leaves of data (3) and meta.tenantId.
    const engine = engineWith(spyingPlugin(), { limits: { maxInputLeaves: 4 } });
    await engine.evaluate(rules(1), makeInput({ data: { a: 1, b: 2, c: 3 } }));
    const error = await failureOf(() =>
      engine.evaluate(rules(1), makeInput({ data: { a: 1, b: 2, c: 3, d: 4 }, requestId: 'r2' })),
    );
    expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 4, actual: 5 });
  });

  describe('at construction', () => {
    const refusal = (limits: unknown): ValidationError => {
      try {
        engineWith(spyingPlugin(), { limits: limits as never });
      } catch (error) {
        if (error instanceof ValidationError) return error;
        throw error;
      }
      return expect.unreachable('should have thrown');
    };

    it('refuses a limit of 0', () => {
      expect(refusal({ maxRules: 0 }).reasons).toEqual([
        'limits.maxRules must be a positive integer',
      ]);
    });

    it('refuses an unknown limit', () => {
      expect(refusal({ maxRulez: 5 }).reasons).toEqual(['unknown limit: maxRulez']);
    });

    it('refuses a maxInputDepth above 1000, the limit of validateProofInput', () => {
      expect(refusal({ maxInputDepth: 1001 }).reasons).toEqual([
        'limits.maxInputDepth must be at most 1000',
      ]);
      expect(() => engineWith(spyingPlugin(), { limits: { maxInputDepth: 1000 } })).not.toThrow();
    });
  });
});
