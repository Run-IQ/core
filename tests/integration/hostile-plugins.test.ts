import { afterEach, describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext, BeforeEvaluateResult } from '../../src/types/plugin.js';
import type { UnsealedResult } from '../../src/types/result.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PipelineTimeoutError, PluginHookError } from '../../src/index.js';
import {
  makeRule,
  makeInput,
  StubModel,
  InMemorySnapshotAdapter,
  expectSameFailure,
} from '../helpers.js';

// These plugins break the hook contract on purpose, the way untyped JavaScript plugins can.

const host: PPEPlugin = {
  name: 'model-host',
  version: '1.0.0',
  onInit(context: PluginContext): void {
    context.modelRegistry.register(new StubModel('m', 100));
  },
};

function pluginWith(name: string, hooks: Partial<PPEPlugin>): PPEPlugin {
  return { name, version: '1.0.0', onInit: () => undefined, ...hooks };
}

function engineWith(
  plugins: PPEPlugin[],
  config: Partial<PPEEngineConfig> = {},
  dsls: DSLEvaluator[] = [],
): PPEEngine {
  return new PPEEngine({ plugins: [host, ...plugins], dsls, strict: false, ...config });
}

/** Builds the value a hook returns without the types' help, as untyped code would. */
function untyped<T>(value: unknown): T {
  // justification: hostile plugins return values outside the hook types on purpose.
  return value as T;
}

const rule = () => makeRule({ id: 'r1', model: 'm' });

/** What `evaluate` rejects with, or `undefined` when it resolves. */
async function failure(engine: PPEEngine, rules = [rule()]): Promise<unknown> {
  return engine.evaluate(rules, makeInput()).then(
    () => undefined,
    (error: unknown) => error,
  );
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('hostile thrown values', () => {
  const thrown: [string, () => unknown, string][] = [
    ['a number', () => 42, '42'],
    ['a symbol', () => Symbol('s'), 'Symbol(s)'],
    ['a null-prototype object', () => Object.create(null), 'Error'],
    ['a revoked proxy', revokedProxy, 'Error'],
    [
      'a proxy whose getPrototypeOf throws',
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('trap');
            },
          },
        ),
      'Error',
    ],
  ];
  for (const hook of ['beforeEvaluate', 'afterEvaluate'] as const) {
    for (const [label, make, message] of thrown) {
      it(`${hook} throwing ${label} fails the evaluation with a PluginHookError`, async () => {
        const onError = vi.fn();
        const value = make();
        const bad = pluginWith('bad', {
          [hook]: () => {
            throw value;
          },
          onError,
        });
        const error = await failure(engineWith([bad]));
        expect(error).toBeInstanceOf(PluginHookError);
        expect(error).toMatchObject({
          code: 'PLUGIN_HOOK',
          plugin: 'bad',
          hook,
          message: `plugin bad ${hook} failed: ${message}`,
        });
        // Never the hostile object itself: a copy where it can be read, else a marker string.
        expect(error instanceof PluginHookError).toBe(true);
        // Whatever was thrown, the engine holds its text: a frozen plain record, never the value.
        const cause = (error as PluginHookError).cause as { name: string; message: string };
        expect(cause !== value).toBe(true);
        expect(Object.isFrozen(cause)).toBe(true);
        expect(Object.getPrototypeOf(cause)).toBe(Object.prototype);
        expect(cause.message).toBe(message === 'Error' ? '' : message);
        expect(onError).toHaveBeenCalledTimes(1);
        expectSameFailure(onError.mock.calls[0]?.[0], error);
      });
    }
  }
});

describe('hostile beforeEvaluate results', () => {
  const cases: [string, (result: BeforeEvaluateResult) => unknown, string][] = [
    ['undefined', () => undefined, 'returned undefined, not a result'],
    ['{}', () => ({}), 'returned a malformed input'],
    ['an input without rules', (r) => ({ input: r.input }), 'returned a malformed rules'],
    ['rules: 5', (r) => ({ input: r.input, rules: 5 }), 'returned a malformed rules'],
    ['rules: [5]', (r) => ({ input: r.input, rules: [5] }), 'returned a malformed rules'],
    ['skipped: 5', (r) => ({ ...r, skipped: 5 }), 'returned a malformed skipped'],
    [
      'a skip without a rule object',
      (r) => ({ ...r, skipped: [{ rule: 5, reason: 'x' }] }),
      'returned a malformed skipped',
    ],
    [
      'a skip without a string reason',
      (r) => ({ ...r, skipped: [{ rule: r.rules[0], reason: 5 }] }),
      'returned a malformed skipped',
    ],

    [
      'a state getter that throws',
      (r) => {
        const out = { ...r };
        Object.defineProperty(out, 'state', {
          enumerable: true,
          get() {
            throw new Error('state getter');
          },
        });
        return out;
      },
      'state getter',
    ],
  ];
  for (const [label, make, message] of cases) {
    it(`fails the evaluation for ${label}, whatever else the result holds`, async () => {
      const onError = vi.fn();
      const bad = pluginWith('bad', {
        beforeEvaluate: (input, _rules) =>
          untyped<BeforeEvaluateResult>(
            make({ input: { ...input, data: { ...input.data, marked: true } }, rules: [] }),
          ),
        onError,
      });
      let seen: unknown;
      const reader = pluginWith('reader', {
        beforeEvaluate(input, rules): BeforeEvaluateResult {
          seen = input.data['marked'];
          return { input, rules };
        },
      });
      const error = await failure(engineWith([bad, reader]));
      expect(error).toBeInstanceOf(PluginHookError);
      expect(error).toMatchObject({ plugin: 'bad', hook: 'beforeEvaluate' });
      // The plugin after it is never reached: nothing of the result is used.
      expect(seen).toBeUndefined();
      const expected =
        message === 'state getter' ? message : `plugin bad beforeEvaluate ${message}`;
      expect((error as PluginHookError).cause).toMatchObject({ message: expected });
      expect(onError).toHaveBeenCalledTimes(1);
      expectSameFailure(onError.mock.calls[0]?.[0], error);
    });
  }

  it('reads the state once: a getter cannot pass the JSON check and then return a Date', async () => {
    let reads = 0;
    const st = pluginWith('st', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        const state = {};
        Object.defineProperty(state, 'x', {
          enumerable: true,
          get: () => (reads++ === 0 ? 1 : new Date(0)),
        });
        return { input, rules, state };
      },
    });
    const result = await engineWith([st]).evaluate([rule()], makeInput());
    expect(result.pluginState).toEqual({ st: { x: 1 } });
    expect(result.diagnostics).toEqual([]);
  });

  it('gives a plugin skip without detail the detail "plugin <name>: skipped"', async () => {
    const fiscal = pluginWith('fiscal', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [],
        skipped: rules.map((r) => ({ rule: r, reason: 'PLUGIN' as const })),
      }),
    });
    const result = await engineWith([fiscal]).evaluate([rule()], makeInput());
    expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
      ['r1', 'PLUGIN', 'plugin fiscal: skipped'],
    ]);
  });
});

describe('hostile afterEvaluate results', () => {
  for (const [returned, described] of [
    [null, 'null'],
    [42, '42'],
    ['str', '"str"'],
  ] as const) {
    it(`fails the evaluation for an afterEvaluate result that is ${described}`, async () => {
      const bad = pluginWith('bad', { afterEvaluate: () => untyped<never>(returned) });
      const error = await failure(engineWith([bad]));
      expect(error).toBeInstanceOf(PluginHookError);
      expect(error).toMatchObject({ plugin: 'bad', hook: 'afterEvaluate' });
      expect((error as PluginHookError).cause).toMatchObject({
        message: `plugin bad afterEvaluate returned ${described}, not annotations`,
      });
    });
  }

  it('reads annotations once: a getter answering one object, then another, is judged on its first answer', async () => {
    let reads = 0;
    const bad = pluginWith('p', {
      afterEvaluate: () =>
        untyped<never>({
          get annotations() {
            reads += 1;
            return reads === 1 ? { first: 1 } : { second: 2 };
          },
        }),
    });
    const result = await engineWith([bad]).evaluate([rule()], makeInput());
    expect(reads).toBe(1);
    expect(result.meta).toEqual({ p: { first: 1 } });
  });

  it('fails the evaluation when a plugin returns engine-owned fields, naming the first', async () => {
    const bad = pluginWith('bad', {
      afterEvaluate: (_input, result) => untyped<never>({ ...result, value: 99 }),
    });
    const error = await failure(engineWith([bad]));
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: 'bad', hook: 'afterEvaluate' });
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin bad afterEvaluate returned a field other than annotations: requestId',
    });
  });

  it('fails the evaluation for a symbol key and for a class instance', async () => {
    class Result {
      annotations = { a: 1 };
    }
    for (const returned of [{ [Symbol('s')]: 1 }, new Result()]) {
      const bad = pluginWith('bad', { afterEvaluate: () => untyped<never>(returned) });
      const error = await failure(engineWith([bad]));
      expect(error).toBeInstanceOf(PluginHookError);
    }
  });

  it('accepts annotations: the same trace, the decision untouched', async () => {
    const good = pluginWith('good', { afterEvaluate: () => ({ annotations: { note: 'ok' } }) });
    const plain = await engineWith([]).evaluate([rule()], makeInput());
    const result = await engineWith([good]).evaluate([rule()], makeInput());
    expect(result.meta).toEqual({ good: { note: 'ok' } });
    expect(result.value).toBe(plain.value);
    expect(result.appliedRules).toEqual(plain.appliedRules);
    expect(result.trace.steps.length).toBe(plain.trace.steps.length);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('pipeline timeout abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the late pipeline: no afterEvaluate, no save, no onError', async () => {
    const adapter = new InMemorySnapshotAdapter();
    const save = vi.spyOn(adapter, 'save');
    const afterEvaluate = vi.fn((_input: unknown, _result: UnsealedResult) => undefined);
    const onError = vi.fn();
    let release: () => void = () => undefined;
    const slow = pluginWith('slow', {
      beforeEvaluate: (input, rules) =>
        new Promise<BeforeEvaluateResult>((resolve) => {
          release = () => resolve({ input, rules });
        }),
      afterEvaluate,
      onError,
    });
    const engine = engineWith([slow], {
      timeout: { hook: 10_000, pipeline: 20 },
      snapshot: adapter,
    });
    await expect(engine.evaluate([rule()], makeInput())).rejects.toThrow(PipelineTimeoutError);
    release();
    // Lets the late pipeline run to its end.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(afterEvaluate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('fields read by name', () => {
  it('keeps a non-enumerable state', async () => {
    const p = pluginWith('p', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        const out: BeforeEvaluateResult = { input, rules };
        Object.defineProperty(out, 'state', { value: { a: 1 } });
        return out;
      },
    });
    const result = await engineWith([p]).evaluate([rule()], makeInput());
    expect(result.pluginState).toEqual({ p: { a: 1 } });
  });

  it('uses a non-enumerable skipped', async () => {
    const p = pluginWith('p', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        const out: BeforeEvaluateResult = { input, rules: [] };
        Object.defineProperty(out, 'skipped', {
          value: rules.map((r) => ({ rule: r, reason: 'PLUGIN' })),
        });
        return out;
      },
    });
    const result = await engineWith([p]).evaluate([rule()], makeInput());
    expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
      ['r1', 'PLUGIN', 'plugin p: skipped'],
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts a class result whose fields are prototype getters, reading each once', async () => {
    const reads: string[] = [];
    class Result implements BeforeEvaluateResult {
      constructor(
        private readonly given: BeforeEvaluateResult['input'],
        private readonly source: BeforeEvaluateResult['rules'],
      ) {}
      get input(): BeforeEvaluateResult['input'] {
        reads.push('input');
        return this.given;
      }
      get rules(): BeforeEvaluateResult['rules'] {
        reads.push('rules');
        return [];
      }
      get skipped(): NonNullable<BeforeEvaluateResult['skipped']> {
        reads.push('skipped');
        return this.source.map((r) => ({ rule: r, reason: 'PLUGIN' as const }));
      }
      get state(): BeforeEvaluateResult['state'] {
        reads.push('state');
        return { cls: true };
      }
    }
    const p = pluginWith('p', { beforeEvaluate: (input, rules) => new Result(input, rules) });
    const result = await engineWith([p]).evaluate([rule()], makeInput());
    expect(reads.sort()).toEqual(['input', 'rules', 'skipped', 'state']);
    expect(result.pluginState).toEqual({ p: { cls: true } });
    expect(result.skippedRules.map((s) => s.rule.id)).toEqual(['r1']);
    expect(result.appliedRules).toEqual([]);
  });
});

describe('rules removed without a skip', () => {
  it('fails the evaluation, naming them by id then version', async () => {
    const p = pluginWith('p', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: rules.filter((r) => r.id === 'keep'),
        skipped: rules
          .filter((r) => r.id === 'listed')
          .map((r) => ({ rule: r, reason: 'PLUGIN' as const })),
      }),
    });
    const error = await failure(engineWith([p]), [
      makeRule({ id: 'b', model: 'm', version: 2 }),
      makeRule({ id: 'keep', model: 'm' }),
      makeRule({ id: 'listed', model: 'm' }),
      makeRule({ id: 'b', model: 'm', version: 1 }),
      makeRule({ id: 'a', model: 'm' }),
    ]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: 'p', hook: 'beforeEvaluate' });
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin p removed rules without a skip: a@1, b@1, b@2',
    });
  });
});

describe('rules removed or added by beforeEvaluate (multisets)', () => {
  it('fails the evaluation for a dropped duplicate, and names it', async () => {
    const p = pluginWith('p', {
      beforeEvaluate: (input, rules) => ({ input, rules: rules.slice(1) }),
    });
    const d = makeRule({ id: 'd', model: 'm' });
    const error = await failure(engineWith([p]), [d, { ...d }]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin p removed rules without a skip: d@1',
    });
  });

  it('fails the evaluation for a rule replaced by another version: the old one is lost', async () => {
    const p = pluginWith('p', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: rules.map((r) => makeRule({ id: r.id, model: 'm', version: r.version + 1 })),
      }),
    });
    const error = await failure(engineWith([p]), [makeRule({ id: 'v', model: 'm' })]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin p removed rules without a skip: v@1',
    });
  });

  it('fails the evaluation for a given rule returned twice: it would count twice', async () => {
    const p = pluginWith('p', {
      beforeEvaluate: (input, rules) => ({ input, rules: [...rules, ...rules] }),
    });
    const error = await failure(engineWith([p]));
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin p returned rule r1@1 2 times (rules and skips together), it was given 1',
    });
  });

  it('names the rules added, sorted by id then version', async () => {
    const p = pluginWith('p', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [
          ...rules,
          makeRule({ id: 'z', model: 'm' }),
          makeRule({ id: 'a', model: 'm', version: 3 }),
        ],
      }),
    });
    const result = await engineWith([p]).evaluate([rule()], makeInput());
    expect(result.diagnostics.map((x) => x.message)).toEqual(['plugin p added rules: a@3, z@1']);
  });

  it('fails the evaluation for a rule added twice', async () => {
    const extra = makeRule({ id: 'z', model: 'm' });
    const p = pluginWith('p', {
      beforeEvaluate: (input, rules) => ({ input, rules: [...rules, extra, extra] }),
    });
    const error = await failure(engineWith([p]));
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin p added rule z@1 more than once',
    });
  });
});

describe('hook timer on abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the in-flight hook timer when the pipeline times out', async () => {
    vi.useFakeTimers();
    const hang = pluginWith('hang', {
      beforeEvaluate: () => new Promise<BeforeEvaluateResult>(() => undefined),
    });
    const engine = engineWith([hang], { timeout: { hook: 10_000, pipeline: 20 } });
    const outcome = engine.evaluate([rule()], makeInput());
    const settled = expect(outcome).rejects.toThrow(PipelineTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await settled;
    expect(vi.getTimerCount()).toBe(0);
  });
});
