import { describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { HookTimeoutError } from '../../src/errors/HookTimeoutError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { PPEError } from '../../src/errors/PPEError.js';
import type { Rule } from '../../src/types/rule.js';
import {
  makeRule,
  makeInput,
  StubModel,
  InMemorySnapshotAdapter,
  expectSameFailure,
} from '../helpers.js';

// Fail closed: a decision is never returned when it was computed without the preparation a
// plugin was supposed to do. Every failure of a hook is a PluginHookError; onError is called on
// every plugin, and nothing is saved.

interface Setup {
  readonly engine: PPEEngine;
  readonly adapter: InMemorySnapshotAdapter;
  /** What each plugin's onError was given, by plugin name. */
  readonly told: Record<string, unknown[]>;
}

const host: PPEPlugin = {
  name: 'host',
  version: '1.0.0',
  onInit(context: PluginContext): void {
    context.modelRegistry.register(new StubModel('M', 10));
  },
};

/** An engine with a plugin under test and a witness whose onError is recorded. */
function setup(hooks: Partial<PPEPlugin>, config: Partial<PPEEngineConfig> = {}): Setup {
  const adapter = new InMemorySnapshotAdapter();
  const told: Record<string, unknown[]> = { bad: [], witness: [] };
  const record =
    (name: string) =>
    (error: PPEError): void => {
      told[name]?.push(error);
    };
  const bad: PPEPlugin = {
    name: 'bad',
    version: '1.0.0',
    onInit: () => undefined,
    ...hooks,
    onError: record('bad'),
  };
  const witness: PPEPlugin = {
    name: 'witness',
    version: '1.0.0',
    onInit: () => undefined,
    onError: record('witness'),
  };
  const engine = new PPEEngine({
    plugins: [host, bad, witness],
    dsls: [],
    strict: false,
    snapshot: adapter,
    ...config,
  });
  return { engine, adapter, told };
}

const rules = [makeRule({ id: 'r1', model: 'M' }), makeRule({ id: 'r2', model: 'M' })];

/** Evaluates and returns what it rejected with. */
async function failure(setupResult: Setup, input = makeInput()): Promise<unknown> {
  return setupResult.engine.evaluate(rules, input).then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** The failure is a PluginHookError of `hook`, every plugin was told of that very error, and nothing was saved. */
async function expectHookFailure(
  setupResult: Setup,
  hook: 'beforeEvaluate' | 'afterEvaluate',
  check: (cause: unknown) => void,
  input = makeInput(),
): Promise<PluginHookError> {
  const error = await failure(setupResult, input);
  expect(error).toBeInstanceOf(PluginHookError);
  const hookError = error as PluginHookError;
  expect(hookError).toMatchObject({ code: 'PLUGIN_HOOK', plugin: 'bad', hook });
  check(hookError.cause);
  for (const name of ['bad', 'witness']) {
    expect(setupResult.told[name]).toHaveLength(1);
    expectSameFailure(setupResult.told[name]?.[0], hookError);
  }
  expect(await setupResult.adapter.exists(input.requestId)).toBe(false);
  return hookError;
}

describe('beforeEvaluate that fails makes the evaluation fail', () => {
  it('a hook that throws: the cause is what it threw', async () => {
    const boom = new Error('boom');
    const s = setup({
      beforeEvaluate: () => {
        throw boom;
      },
    });
    const error = await expectHookFailure(s, 'beforeEvaluate', (cause) => expect(cause).toBe(boom));
    expect(error.message).toBe('plugin bad beforeEvaluate failed: boom');
  });

  it('a hook that times out: the cause is the HookTimeoutError', async () => {
    const s = setup(
      {
        beforeEvaluate: async (input, given) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { input, rules: given };
        },
      },
      { timeout: { hook: 20 } },
    );
    await expectHookFailure(s, 'beforeEvaluate', (cause) => {
      expect(cause).toBeInstanceOf(HookTimeoutError);
      expect(cause).toMatchObject({ pluginName: 'bad', timeoutMs: 20 });
    });
  });

  it('a malformed result: the cause names what was returned', async () => {
    const s = setup({ beforeEvaluate: (() => 42) as never });
    await expectHookFailure(s, 'beforeEvaluate', (cause) => {
      expect(cause).toBeInstanceOf(TypeError);
      expect((cause as Error).message).toBe('plugin bad beforeEvaluate returned 42, not a result');
    });
  });

  it('a getter that throws while the result is read', async () => {
    const trap = new Error('getter');
    const s = setup({
      beforeEvaluate: () => ({
        get input(): never {
          throw trap;
        },
        rules,
      }),
    });
    await expectHookFailure(s, 'beforeEvaluate', (cause) => expect(cause).toBe(trap));
  });

  it('a state that is not JSON: it would have been dropped', async () => {
    const s = setup({
      beforeEvaluate: (input, given) =>
        ({ input, rules: given, state: { a: [1, new Date(0)] } }) as never,
    });
    await expectHookFailure(s, 'beforeEvaluate', (cause) => {
      expect(cause).toBeInstanceOf(TypeError);
      expect((cause as Error).message).toBe(
        'plugin bad beforeEvaluate returned a state that is not JSON at $.a[1] (Date)',
      );
    });
  });

  it('rules removed without a skip: the engine would have accepted the loss in silence', async () => {
    const s = setup({
      beforeEvaluate: (input, given) => ({ input, rules: given.filter((r) => r.id !== 'r2') }),
    });
    await expectHookFailure(s, 'beforeEvaluate', (cause) => {
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toBe('plugin bad removed rules without a skip: r2@1');
    });
  });

  describe("an input that fails the checks of the caller's input (bounds, spec, strict mode)", () => {
    it('a root key of data starting with $ (D-3)', async () => {
      const s = setup({
        beforeEvaluate: (input, given) => ({
          input: { ...input, data: { ...input.data, $outputs: 'x' } },
          rules: given,
        }),
      });
      await expectHookFailure(s, 'beforeEvaluate', (cause) => {
        expect(cause).toBeInstanceOf(ValidationError);
        expect((cause as ValidationError).reasons).toEqual(['reserved key /data/$outputs']);
      });
    });

    it('a number of 2^53 or more (D-5)', async () => {
      const s = setup({
        beforeEvaluate: (input, given) => ({
          input: { ...input, data: { ...input.data, big: 2 ** 60 } },
          rules: given,
        }),
      });
      await expectHookFailure(s, 'beforeEvaluate', (cause) => {
        expect(cause).toBeInstanceOf(ValidationError);
        expect((cause as ValidationError).reasons).toEqual(['number beyond 2^53 at /data/big']);
      });
    });

    it('a date that is not a date', async () => {
      const s = setup({
        beforeEvaluate: (input, given) => ({
          input: { ...input, meta: { ...input.meta, dates: { effective: '2026-13-01' } } },
          rules: given,
        }),
      });
      await expectHookFailure(s, 'beforeEvaluate', (cause) => {
        expect(cause).toBeInstanceOf(ValidationError);
        expect((cause as ValidationError).reasons).toHaveLength(1);
        expect((cause as ValidationError).reasons[0]).toMatch(/^meta\.dates\.effective: /);
      });
    });

    it('an input past maxInputLeaves', async () => {
      const s = setup(
        {
          beforeEvaluate: (input, given) => ({
            input: { ...input, data: { a: 1, b: 2, c: 3, d: 4, e: 5 } },
            rules: given,
          }),
        },
        { limits: { maxInputLeaves: 4 } },
      );
      await expectHookFailure(s, 'beforeEvaluate', (cause) => {
        expect(cause).toBeInstanceOf(EngineLimitError);
        expect(cause).toMatchObject({ limit: 'maxInputLeaves', max: 4, actual: 5 });
      });
    });

    it('an input past maxInputDepth', async () => {
      const s = setup(
        {
          beforeEvaluate: (input, given) => ({
            input: { ...input, data: { a: { b: { c: 1 } } } },
            rules: given,
          }),
        },
        { limits: { maxInputDepth: 2 } },
      );
      await expectHookFailure(s, 'beforeEvaluate', (cause) => {
        expect(cause).toMatchObject({ limit: 'maxInputDepth', max: 2, actual: 3 });
      });
    });

    it('in strict mode, an input that no longer names the evaluation date', async () => {
      const s = setup(
        {
          beforeEvaluate: (input, given) => ({
            input: { ...input, meta: { tenantId: input.meta.tenantId } },
            rules: given,
          }),
        },
        { strict: true },
      );
      const input = makeInput({
        meta: { tenantId: 't', effectiveDate: new Date('2026-01-01T00:00:00Z') },
      });
      await expectHookFailure(
        s,
        'beforeEvaluate',
        (cause) => {
          expect(cause).toBeInstanceOf(ValidationError);
          expect((cause as ValidationError).reasons).toEqual([
            'meta.effectiveDate or meta.dates.effective must be provided when strict mode is enabled',
          ]);
        },
        input,
      );
    });
  });
});

describe('afterEvaluate that fails makes the evaluation fail', () => {
  it('a hook that throws: the cause is what it threw', async () => {
    const boom = new Error('after boom');
    const s = setup({
      afterEvaluate: () => {
        throw boom;
      },
    });
    const error = await expectHookFailure(s, 'afterEvaluate', (cause) => expect(cause).toBe(boom));
    expect(error.message).toBe('plugin bad afterEvaluate failed: after boom');
  });

  it('a hook that times out', async () => {
    const s = setup(
      {
        afterEvaluate: async (_input, result) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return result;
        },
      },
      { timeout: { hook: 20 } },
    );
    await expectHookFailure(s, 'afterEvaluate', (cause) => {
      expect(cause).toBeInstanceOf(HookTimeoutError);
      expect(cause).toMatchObject({ hook: 'afterEvaluate' });
    });
  });

  it('a malformed result', async () => {
    const s = setup({ afterEvaluate: (() => 42) as never });
    await expectHookFailure(s, 'afterEvaluate', (cause) => {
      expect(cause).toBeInstanceOf(TypeError);
      expect((cause as Error).message).toBe('plugin bad afterEvaluate returned 42, not a result');
    });
  });

  it('the decision changed: it would have been replaced', async () => {
    const s = setup({
      afterEvaluate: (_input, result) => ({ ...result, appliedRules: 'nope' as never }),
    });
    await expectHookFailure(s, 'afterEvaluate', (cause) => {
      expect(cause).toBeInstanceOf(TypeError);
      expect((cause as Error).message).toBe(
        'plugin bad afterEvaluate changed the decision: appliedRules',
      );
    });
  });

  it('a value rewritten, even to a finite number', async () => {
    const s = setup({
      afterEvaluate: (_input, result) => ({ ...result, value: 99 }),
    });
    await expectHookFailure(s, 'afterEvaluate', (cause) => {
      expect((cause as Error).message).toBe('plugin bad afterEvaluate changed the decision: value');
    });
  });

  it('a value rewritten to something that is not a number', async () => {
    const s = setup({
      afterEvaluate: (_input, result) => ({ ...result, value: 'many' }),
    });
    await expectHookFailure(s, 'afterEvaluate', (cause) => {
      expect((cause as Error).message).toBe('plugin bad afterEvaluate changed the decision: value');
    });
  });

  it('engine fields changed', async () => {
    const s = setup({
      afterEvaluate: (_input, result) => ({ ...result, requestId: 'other', engineVersion: '9' }),
    });
    await expectHookFailure(s, 'afterEvaluate', (cause) => {
      expect((cause as Error).message).toBe(
        'plugin bad afterEvaluate changed the decision: engineVersion, requestId',
      );
    });
  });

  it('rules removed from the applied rules, with no skip', async () => {
    const s = setup({
      afterEvaluate: (_input, result) => ({
        ...result,
        appliedRules: result.appliedRules.filter((r) => r.id !== 'r2'),
      }),
    });
    await expectHookFailure(s, 'afterEvaluate', (cause) => {
      expect((cause as Error).message).toBe(
        'plugin bad afterEvaluate changed the decision: appliedRules',
      );
    });
  });
});

describe('a rule a beforeEvaluate hook returns is the rule it was given, or a verified new one', () => {
  const given = (ruleId: string) => rules.find((r) => r.id === ruleId)!;
  /** `rule` with `params.rate` changed and the checksum recomputed: a different rule, well formed. */
  const rewritten = (ruleId: string): Rule => {
    const original = given(ruleId);
    return makeRule({ ...original, params: { rate: 0 } });
  };

  it('a rule rewritten under the same id and version, with its checksum recomputed', async () => {
    const s = setup({
      beforeEvaluate: (input, given) => ({
        input: { ...input, data: { ...input.data, revenue: 1 } },
        rules: given.map((r) => (r.id === 'r1' ? rewritten('r1') : r)),
      }),
    });
    await expectHookFailure(s, 'beforeEvaluate', (cause) => {
      expect((cause as Error).message).toBe(
        'plugin bad rewrote rule r1@1: its content is not the one it was given',
      );
    });
  });

  it('a rule rewritten under the same id and version, with the old checksum', async () => {
    const s = setup({
      beforeEvaluate: (input, given) => ({
        input,
        rules: given.map((r) => (r.id === 'r1' ? { ...r, params: { rate: 0 } } : r)),
      }),
    });
    await expectHookFailure(s, 'beforeEvaluate', (cause) => {
      expect((cause as Error).message).toBe(
        'plugin bad rewrote rule r1@1: its content is not the one it was given',
      );
    });
  });

  it('a rule that is the same under a recomputed checksum is the same rule', async () => {
    const s = setup({
      beforeEvaluate: (input, given) => ({
        input,
        rules: given.map((r) => makeRule({ ...r })),
      }),
    });
    const result = await s.engine.evaluate(rules, makeInput());
    expect(result.appliedRules.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('an added rule with a bad checksum', async () => {
    const s = setup({
      beforeEvaluate: (input, given) => ({
        input,
        rules: [...given, { ...makeRule({ id: 'extra', model: 'M' }), checksum: 'f'.repeat(64) }],
      }),
    });
    await expectHookFailure(s, 'beforeEvaluate', (cause) => {
      expect((cause as Error).message).toBe(
        'plugin bad added rule extra@1: Checksum mismatch for rule extra@1',
      );
    });
  });

  it('an added rule that spec cannot checksum', async () => {
    const s = setup({
      beforeEvaluate: (input, given) => ({
        input,
        rules: [...given, { ...makeRule({ id: 'extra', model: 'M' }), version: 1.5 }],
      }),
    });
    await expectHookFailure(s, 'beforeEvaluate', (cause) => {
      expect((cause as Error).message).toMatch(/^plugin bad added rule extra@1\.5: /);
    });
  });

  it('an added rule with a good checksum is evaluated', async () => {
    const s = setup({
      beforeEvaluate: (input, given) => ({
        input,
        rules: [...given, makeRule({ id: 'extra', model: 'M' })],
      }),
    });
    const result = await s.engine.evaluate(rules, makeInput());
    expect(result.appliedRules.map((r) => r.id)).toEqual(['extra', 'r1', 'r2']);
  });

  it('a change to the input data stays allowed', async () => {
    const s = setup({
      beforeEvaluate: (input, given) => ({
        input: { ...input, data: { ...input.data, revenue: 1 } },
        rules: given,
      }),
    });
    const result = await s.engine.evaluate(rules, makeInput());
    expect(result.appliedRules.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

describe('what a hook does that the engine accepts as it is stays a diagnostic', () => {
  it('rules a hook adds are evaluated and named', async () => {
    const extra = makeRule({ id: 'extra', model: 'M' });
    const s = setup({
      beforeEvaluate: (input, given) => ({ input, rules: [...given, extra] }),
    });
    const result = await s.engine.evaluate(rules, makeInput());
    expect(result.appliedRules.map((r) => r.id)).toEqual(['extra', 'r1', 'r2']);
    expect(result.diagnostics).toEqual([
      {
        source: 'hook',
        plugin: 'bad',
        hook: 'beforeEvaluate',
        message: 'plugin bad added rules: extra@1',
      },
    ]);
    expect(s.told['bad']).toEqual([]);
  });
});

describe('a hook failure does not run the later hooks', () => {
  it('afterEvaluate is not called when beforeEvaluate failed', async () => {
    const after = vi.fn((_input: unknown, result: unknown) => result);
    const s = setup({
      beforeEvaluate: () => {
        throw new Error('stop');
      },
      afterEvaluate: after as never,
    });
    await failure(s);
    expect(after).not.toHaveBeenCalled();
  });

  it("a later plugin's beforeEvaluate is not called either", async () => {
    const later = vi.fn((input: unknown, given: unknown) => ({ input, rules: given }));
    const adapter = new InMemorySnapshotAdapter();
    const engine = new PPEEngine({
      plugins: [
        host,
        {
          name: 'first',
          version: '1.0.0',
          onInit: () => undefined,
          beforeEvaluate: () => {
            throw new Error('first fails');
          },
        },
        {
          name: 'second',
          version: '1.0.0',
          onInit: () => undefined,
          beforeEvaluate: later as never,
        },
      ],
      dsls: [],
      strict: false,
      snapshot: adapter,
    });
    const error = await engine.evaluate(rules, makeInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PluginHookError);
    expect(later).not.toHaveBeenCalled();
    expect(await adapter.exists('test-request-001')).toBe(false);
  });
});
