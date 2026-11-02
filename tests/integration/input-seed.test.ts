import { describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

function plugin(calls: string[] = []): PPEPlugin {
  return {
    name: 'p',
    version: '1.0.0',
    onInit(context: PluginContext): void {
      context.modelRegistry.register(new StubModel('M', 10));
    },
    beforeEvaluate(input, rules) {
      calls.push('beforeEvaluate');
      return { input, rules };
    },
  };
}

const build = (inputSeed: unknown, calls: string[] = []): PPEEngine =>
  new PPEEngine({
    plugins: [plugin(calls)],
    dsls: [],
    strict: false,
    inputSeed,
  } as PPEEngineConfig);

const reasonsOf = async (run: () => unknown): Promise<[string, readonly string[]]> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return [error.message, error.reasons];
    throw error;
  }
  return expect.unreachable('should have thrown');
};

const rules = [makeRule({ id: 'r1', model: 'M' })];

describe('inputSeed', () => {
  describe('derive(requestId): exactly 32 bytes, checked at each evaluation', () => {
    it('refuses 31 bytes at the first evaluation, before any hook', async () => {
      const calls: string[] = [];
      const engine = build({ derive: () => new Uint8Array(31) }, calls);
      const [message, reasons] = await reasonsOf(() => engine.evaluate(rules, makeInput()));
      expect(message).toBe('Invalid inputSeed');
      expect(reasons).toEqual(['inputSeed.derive must return 32 bytes']);
      expect(calls).toEqual([]);
    });

    it('refuses 33 bytes, and a value that is not bytes', async () => {
      for (const bad of [new Uint8Array(33), 'x'.repeat(32), [1, 2, 3], null]) {
        const engine = build({ derive: () => bad });
        const [, reasons] = await reasonsOf(() => engine.evaluate(rules, makeInput()));
        expect(reasons).toEqual(['inputSeed.derive must return 32 bytes']);
      }
    });

    it('names a derive that throws', async () => {
      const engine = build({
        derive: () => {
          throw new Error('boom');
        },
      });
      const [, reasons] = await reasonsOf(() => engine.evaluate(rules, makeInput()));
      expect(reasons).toEqual(['inputSeed.derive failed: boom']);
    });

    it('accepts 32 bytes, and hands derive the requestId of the input', async () => {
      const derive = vi.fn(() => new Uint8Array(32));
      const calls: string[] = [];
      const engine = build({ derive }, calls);
      await engine.evaluate(rules, makeInput({ requestId: 'req-42' }));
      expect(derive).toHaveBeenCalledTimes(1);
      expect(derive).toHaveBeenCalledWith('req-42');
      expect(calls).toEqual(['beforeEvaluate']);
    });
  });

  describe('secret: at least 32 bytes, checked at construction', () => {
    it('refuses a short secret and a secret that is not bytes', async () => {
      expect(await reasonsOf(() => build({ secret: new Uint8Array(31) }))).toEqual([
        'Invalid inputSeed',
        ['inputSeed.secret must be at least 32 bytes'],
      ]);
      expect(await reasonsOf(() => build({ secret: 'x'.repeat(40) }))).toEqual([
        'Invalid inputSeed',
        ['inputSeed.secret must be a Uint8Array'],
      ]);
    });

    it('accepts 32 bytes and more', async () => {
      await build({ secret: new Uint8Array(32) }).evaluate(rules, makeInput({ requestId: 'a' }));
      await build({ secret: new Uint8Array(64) }).evaluate(rules, makeInput({ requestId: 'b' }));
    });
  });

  it('wants exactly one of secret and derive', async () => {
    expect(await reasonsOf(() => build({}))).toEqual([
      'Invalid inputSeed',
      ['inputSeed must have secret or derive'],
    ]);
    expect(
      await reasonsOf(() =>
        build({ secret: new Uint8Array(32), derive: () => new Uint8Array(32) }),
      ),
    ).toEqual(['Invalid inputSeed', ['inputSeed must have secret or derive, not both']]);
    expect(await reasonsOf(() => build(3))).toEqual([
      'Invalid inputSeed',
      ['inputSeed must be an object'],
    ]);
  });

  it('is optional', async () => {
    await build(undefined).evaluate(rules, makeInput());
  });
});
