import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { executionAsyncResource } from 'node:async_hooks';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { readsOf } from '../../src/context/reads.js';
import { Budget, readBounded } from '../../src/engine/pluginBoundary.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { clipText, hasLoneSurrogate } from '../../src/utils/weight.js';
import { clip } from '../../src/utils/frozenCopy.js';
import type { PPEPlugin } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { EvaluationInput } from '../../src/types/input.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Round 10 of the 9L audit (AD1 to AD9): nothing that comes out of a plugin call is trusted.

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

const FLAT: CalculationModel = {
  name: 'flat',
  version: '1.0.0',
  validateParams: () => ({ valid: true }),
  calculate: (_input, _rule, params) => (params as { rate: number }).rate,
};
const host: PPEPlugin = {
  name: 'host',
  version: '1.0.0',
  onInit(context): void {
    context.modelRegistry.register(FLAT);
    context.modelRegistry.register(new StubModel('m', 10));
  },
};
const pluginWith = (name: string, hooks: Partial<PPEPlugin>): PPEPlugin => ({
  name,
  version: '1.0.0',
  onInit: () => undefined,
  ...hooks,
});
const regModel = (model: unknown): PPEPlugin =>
  pluginWith('reg', { onInit: (c) => c.modelRegistry.register(model as CalculationModel) });
function build(
  plugins: PPEPlugin[],
  config: Partial<PPEEngineConfig> = {},
  dsls: DSLEvaluator[] = [],
): PPEEngine {
  return new PPEEngine({
    plugins: [host, ...plugins],
    dsls,
    strict: false,
    snapshot: new InMemorySnapshotAdapter(),
    ...config,
  });
}
const tax = (rate = 100, id = 'tax'): Rule => makeRule({ id, model: 'flat', params: { rate } });
async function failure(engine: PPEEngine, rules: unknown, input?: unknown): Promise<unknown> {
  return engine.evaluate(rules as Rule[], (input ?? makeInput()) as EvaluationInput).then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Every string in a value, however deep (the keys too). */
function strings(value: unknown, into: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') into.push(value);
  else if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') into.push(key);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) strings(descriptor.value, into, seen);
    }
  }
  return into;
}
const wellFormed = (value: unknown): boolean => strings(value).every((s) => !hasLoneSurrogate(s));

const BIG = 'x'.repeat(1_000_001);

describe('AD1, B71, B75: an engine error raised for plugin code is a plugin fault', () => {
  // Each source makes the engine raise a real EngineLimitError for the plugin, inside its call.
  const sources: Array<[string, (context: { register: (m: unknown) => void }) => unknown]> = [
    [
      'readsOf',
      () => {
        const dsl: DSLEvaluator = {
          dsl: 'l',
          version: '1.0.0',
          evaluate: () => true,
          listVariables: () => ['/' + BIG],
        };
        const rule = makeRule({ id: 'c', model: 'm', condition: { dsl: 'l', value: {} } });
        try {
          readsOf(rule, dsl, undefined);
        } catch (error) {
          return error;
        }
        return undefined;
      },
    ],
    [
      'the exported ModelRegistry',
      () => {
        try {
          new ModelRegistry().register({
            name: 'big',
            version: '1.0.0',
            output: { type: 'number', combine: 'sum', note: BIG } as never,
            validateParams: () => ({ valid: true }),
            calculate: () => 1,
          });
        } catch (error) {
          return error;
        }
        return undefined;
      },
    ],
    [
      'the registry facade',
      (context) => {
        try {
          context.register({
            name: 'big2',
            version: '1.0.0',
            output: { type: 'number', combine: 'sum', note: BIG },
            validateParams: () => ({ valid: true }),
            calculate: () => 1,
          });
        } catch (error) {
          return error;
        }
        return undefined;
      },
    ],
  ];

  for (const [name, source] of sources) {
    it(`${name}: thrown from a getter of a beforeEvaluate result, the caller gets text`, async () => {
      let stolen: unknown;
      const engine = build([
        pluginWith('p', {
          onInit: (context) => {
            context.modelRegistry.register(FLAT.name === 'x' ? FLAT : { ...FLAT, name: 'p-flat' });
          },
          beforeEvaluate: (input, rules) => ({
            input,
            rules,
            // The source runs inside the getter, that is, while the engine is reading: the
            // error it raises must not be taken for one the read raised itself.
            get skipped(): never {
              stolen = source({
                register: (m) => engineContext?.modelRegistry.register(m as never),
              });
              throw stolen;
            },
          }),
        }),
        pluginWith('grab', { onInit: (c) => void (engineContext = c) }),
      ]);
      const error = (await failure(engine, [tax()])) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(stolen).toBeDefined();
      expect(error.cause).not.toBe(stolen);
      expect(error.cause).not.toBeInstanceOf(EngineLimitError);
      expect((error.cause as { limit?: unknown }).limit).toBeUndefined();
      expect(Object.getPrototypeOf(error.cause)).toBe(Object.prototype);
      expect(error.message.length).toBeLessThan(1200);
    });

    it(`${name}: thrown from a getter of the annotations, the caller gets text`, async () => {
      let stolen: unknown;
      const engine = build([
        pluginWith('p', {
          afterEvaluate: () => ({
            get annotations(): never {
              stolen = source({
                register: (m) => engineContext?.modelRegistry.register(m as never),
              });
              throw stolen;
            },
          }),
        }),
        pluginWith('grab', { onInit: (c) => void (engineContext = c) }),
      ]);
      const error = (await failure(engine, [tax()])) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(error.cause).not.toBe(stolen);
      expect(error.cause).not.toBeInstanceOf(EngineLimitError);
      expect((error.cause as { limit?: unknown }).limit).toBeUndefined();
    });

    it(`${name}: thrown by the length trap of a listVariables answer, the diagnostic is text`, async () => {
      let stolen: unknown;
      const dsl: DSLEvaluator = {
        dsl: 'l',
        version: '1.0.0',
        evaluate: () => true,
        listVariables: () =>
          new Proxy([] as string[], {
            get(target, key, receiver) {
              if (key === 'length') {
                stolen = source({
                  register: (m) => engineContext?.modelRegistry.register(m as never),
                });
                throw stolen;
              }
              return Reflect.get(target, key, receiver);
            },
          }),
      };
      const engine = build([pluginWith('grab', { onInit: (c) => void (engineContext = c) })], {}, [
        dsl,
      ]);
      const rule = makeRule({
        id: 'c',
        model: 'm',
        condition: { dsl: 'l', value: {} },
      });
      const result = await engine.evaluate([rule], makeInput());
      expect(stolen).toBeDefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
      for (const diagnostic of result.diagnostics) {
        expect(diagnostic.message.length).toBeLessThan(1300);
      }
      expect(JSON.stringify(result.diagnostics)).not.toContain('maxRules');
    });
  }

  it('a nested engine: a limit it raised, thrown by a getter of the outer engine, is text', async () => {
    let stolen: unknown;
    const engine = build([
      pluginWith('p', {
        beforeEvaluate: async (input, rules) => {
          const inner = new PPEEngine({
            plugins: [host],
            dsls: [],
            strict: false,
            limits: { maxRules: 1 },
          });
          stolen = await inner
            .evaluate([tax(1, 'a'), tax(1, 'b')], makeInput({ requestId: 'inner' }))
            .then(
              () => undefined,
              (thrown: unknown) => thrown,
            );
          return {
            input,
            rules,
            get state(): never {
              throw stolen;
            },
          };
        },
      }),
    ]);
    const error = (await failure(engine, [tax()])) as PluginHookError;
    expect(stolen).toBeInstanceOf(EngineLimitError);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).not.toBe(stolen);
    expect(error.cause).not.toBeInstanceOf(EngineLimitError);
    expect((error.cause as { limit?: unknown }).limit).toBeUndefined();
  });

  it('B75 control: a limit passed in what a hook returned is that hook, with text naming the limit', async () => {
    const engine = build(
      [
        pluginWith('p', {
          beforeEvaluate: (input, rules) => ({
            input,
            rules,
            state: new Array(500_000).fill(1) as never,
          }),
        }),
      ],
      { limits: { maxHookLeaves: 100 } },
    );
    const error = (await failure(engine, [tax()])) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: 'p', hook: 'beforeEvaluate' });
    expect(error.cause).toMatchObject({
      name: 'EngineLimitError',
      message: expect.stringContaining('engine limit maxHookLeaves exceeded'),
    });
    expect(error.cause).not.toBeInstanceOf(EngineLimitError);
    expect(Object.getPrototypeOf(error.cause)).toBe(Object.prototype);
    expect(Object.isFrozen(error.cause)).toBe(true);
  });

  it("a limit the engine raises on the caller's own input is the caller's error as it is, frozen", async () => {
    const engine = build([], { limits: { maxRules: 1 } });
    const error = await failure(engine, [tax(1, 'a'), tax(1, 'b')]);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRules', max: 1, actual: 2 });
    expect(Object.isFrozen(error)).toBe(true);
  });
});

let engineContext: Parameters<NonNullable<PPEPlugin['onInit']>>[0] | undefined;

describe('AD4, B72: the engine keeps no state where a plugin can reach it', () => {
  it('a beforeEvaluate that reads the async resource finds nothing of the engine to write', async () => {
    let writable = 0;
    const engine = build([
      pluginWith('p', {
        beforeEvaluate: (input, rules) => {
          const resource = executionAsyncResource() as Record<symbol, unknown>;
          for (const symbol of Object.getOwnPropertySymbols(resource)) {
            const value = resource[symbol];
            if (value instanceof WeakSet || value instanceof Set || value instanceof Map) {
              writable += 1;
            }
          }
          return { input, rules };
        },
      }),
    ]);
    await engine.evaluate([tax()], makeInput());
    expect(writable).toBe(0);
  });
});

describe('AD2, B69: a DSL text that reaches a skip detail is clipped, on both paths', () => {
  const ruleWith = (dsl: string): Rule =>
    makeRule({ id: 'c', model: 'm', condition: { dsl, value: {} } });
  const run = async (verdict: () => unknown): Promise<string> => {
    const dsl: DSLEvaluator = { dsl: 'v', version: '1.0.0', evaluate: verdict as never };
    const result = await build([], {}, [dsl]).evaluate([ruleWith('v')], makeInput());
    expect(result.skippedRules[0]?.reason).toBe('DSL_ERROR');
    return result.skippedRules[0]?.detail ?? '';
  };

  it('a thrown message of 10 000 characters (the R29 path)', async () => {
    const detail = await run(() => {
      throw new Error('w'.repeat(10_000));
    });
    expect(detail.length).toBeLessThanOrEqual(1024 + '... [clipped]'.length);
    expect(detail.endsWith('... [clipped]')).toBe(true);
  });

  it.each([
    [
      '5 000 getters that throw 1 000 characters',
      () => {
        const verdict: Record<string, unknown> = {};
        for (let i = 0; i < 5000; i += 1) {
          Object.defineProperty(verdict, `k${i}`, {
            enumerable: true,
            get(): never {
              throw new Error('t'.repeat(1000));
            },
          });
        }
        return verdict;
      },
    ],
    [
      '5 000 keys with a lone surrogate',
      () => Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}\uD800`, 1])),
    ],
    [
      '5 000 undefined members',
      () => Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, undefined])),
    ],
  ])('an unreadable verdict: %s', async (_name, make) => {
    const detail = await run(make);
    expect(detail.length).toBeLessThanOrEqual(1024 + '... [clipped]'.length);
    expect(hasLoneSurrogate(detail)).toBe(false);
  });
});

describe('AD3, B94: no lone surrogate reaches the record or the caller', () => {
  const key = 'k\uD800';
  const drive = async (plugins: PPEPlugin[], dsls: DSLEvaluator[], rules: Rule[]) => {
    const store = new InMemorySnapshotAdapter();
    const engine = build(plugins, { snapshot: store }, dsls);
    const outcome = await engine.evaluate(rules, makeInput()).then(
      (result) => ({ result, error: undefined as unknown }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { ...outcome, saved: store };
  };
  const check = ({ result, error }: { result?: unknown; error?: unknown }): void => {
    expect(wellFormed(result)).toBe(true);
    if (error instanceof Error) expect(hasLoneSurrogate(error.message)).toBe(false);
    if (error !== undefined) expect(wellFormed(JSON.parse(JSON.stringify({ error })))).toBe(true);
  };

  it('a DSL verdict key', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'v',
      version: '1.0.0',
      evaluate: () => ({ [key]: 1 }) as never,
    };
    const out = await drive(
      [],
      [dsl],
      [makeRule({ id: 'c', model: 'm', condition: { dsl: 'v', value: {} } })],
    );
    check(out);
  });

  it('a model output key', async () => {
    const model: CalculationModel = {
      name: 'ko',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => ({ value: 1, detail: { [key]: 1 } }) as never,
    };
    check(await drive([regModel(model)], [], [makeRule({ id: 'k', model: 'ko' })]));
  });

  it('a validateParams result key', async () => {
    const model: CalculationModel = {
      name: 'kv',
      version: '1.0.0',
      validateParams: () => ({ valid: true, [key]: 1 }) as never,
      calculate: () => 1,
    };
    check(await drive([regModel(model)], [], [makeRule({ id: 'k', model: 'kv' })]));
  });

  it('an annotation key', async () => {
    const plugin = pluginWith('p', { afterEvaluate: () => ({ annotations: { [key]: 1 } }) });
    check(await drive([plugin], [], [tax()]));
  });

  it('a key of a rule a hook adds', async () => {
    const plugin = pluginWith('p', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [...rules, { ...tax(1, 'extra'), params: { [key]: 1 } }],
      }),
    });
    check(await drive([plugin], [], [tax()]));
  });
});

describe('AD6, B57: the shapes of afterEvaluate', () => {
  it.each([[{}], [{ annotations: undefined }], [{ annotations: {} }]])(
    '%j is a plugin fault naming /annotations',
    async (returned) => {
      const engine = build([pluginWith('p', { afterEvaluate: () => returned as never })]);
      const error = (await failure(engine, [tax()])) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect((error.cause as { message: string }).message).toContain('/annotations');
    },
  );
});

describe('AD7, B76: internal classes never leave the engine', () => {
  const internal = ['BoundaryError', 'ReadFailure', 'MalformedResult', 'PluginFaultError'];
  const chain = (value: unknown): string[] => {
    const names: string[] = [];
    for (let at = value as object | null; at !== null && typeof at === 'object';) {
      const proto = Object.getPrototypeOf(at) as object | null;
      if (proto === null) break;
      names.push(String((proto.constructor as { name?: unknown }).name));
      at = proto;
    }
    return names;
  };

  it('a malformed hook result and a throwing state getter: onError and the caller see none', async () => {
    let told: { cause?: unknown } | undefined;
    for (const make of [
      () => 42,
      () => ({
        get state(): never {
          throw new Error('state');
        },
      }),
    ]) {
      const engine = build([
        pluginWith('p', {
          beforeEvaluate: ((input: unknown, rules: unknown) => {
            const made = make() as Record<string, unknown> | number;
            return typeof made === 'number'
              ? made
              : Object.defineProperties({ input, rules }, Object.getOwnPropertyDescriptors(made));
          }) as never,
          onError: (error) => {
            told = error as { cause?: unknown };
          },
        }),
      ]);
      const error = (await failure(
        engine,
        [],
        makeInput({ requestId: `ad7-${Math.random()}` }),
      )) as {
        cause?: unknown;
      };
      for (const seen of [told, told?.cause, error, error.cause]) {
        for (const name of chain(seen)) expect(internal).not.toContain(name);
      }
    }
  });
});

describe('AD8, M4a: a hook promise is adopted through the captured then', () => {
  it('a native promise subclass with its own then is never asked to then', async () => {
    let asked = 0;
    class Sub<T> extends Promise<T> {
      override then<A, B>(
        onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ): Promise<A | B> {
        asked += 1;
        return super.then(onFulfilled, onRejected);
      }
    }
    const engine = build([
      pluginWith('p', {
        beforeEvaluate: ((input: unknown, rules: unknown) =>
          Sub.resolve({ input, rules })) as never,
      }),
    ]);
    const result = await engine.evaluate([tax()], makeInput());
    expect(result.value).toBe(100);
    expect(asked).toBe(0);
  });
});

describe('AD8, M9b: lone surrogates in fault text', () => {
  it('clipText replaces a lone surrogate with U+FFFD, short or long', () => {
    expect(clipText('a\uD800b', 1024, '...')).toBe('a�b');
    expect(clipText('a\uDC00', 1024, '...')).toBe('a�');
    expect(clipText('😀', 1024, '...')).toBe('😀');
  });

  it('the text of a thrown message is well-formed', async () => {
    const engine = build([
      pluginWith('p', {
        beforeEvaluate: () => {
          throw new Error('bad\uD800');
        },
      }),
    ]);
    const error = (await failure(engine, [tax()])) as PluginHookError;
    expect(wellFormed(error.cause)).toBe(true);
    expect(hasLoneSurrogate(error.message)).toBe(false);
  });
});

describe('AD8, M11b: the version bound', () => {
  it('a valid version of 64 characters is accepted and one of 65 is refused', () => {
    const at64 = `1.0.0-${'a'.repeat(58)}`;
    const at65 = `1.0.0-${'a'.repeat(59)}`;
    expect(at64).toHaveLength(64);
    expect(at65).toHaveLength(65);
    expect(() => build([{ ...pluginWith('p', {}), version: at64 }])).not.toThrow();
    expect(() => build([{ ...pluginWith('p', {}), version: at65 }])).toThrow(/version/);
  });
});

describe('B23: a plugin skip has the reason PLUGIN and no other', () => {
  it.each(['MODEL_NOT_FOUND', 'COUNTRY_MISMATCH', 'INHIBITED_BY_META_RULE', 'CHECKSUM_MISMATCH'])(
    '%s is a plugin fault',
    async (reason) => {
      const engine = build([
        pluginWith('p', {
          beforeEvaluate: (input, rules) => ({
            input,
            rules: [],
            skipped: rules.map((rule) => ({ rule, reason: reason as never })),
          }),
        }),
      ]);
      expect(await failure(engine, [tax()])).toBeInstanceOf(PluginHookError);
    },
  );
  it('PLUGIN is accepted, and its detail is prefixed with the plugin', async () => {
    const engine = build([
      pluginWith('p', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [],
          skipped: rules.map((rule) => ({ rule, reason: 'PLUGIN' as const, detail: 'no' })),
        }),
      }),
    ]);
    const result = await engine.evaluate([tax()], makeInput());
    expect(result.skippedRules[0]).toMatchObject({ reason: 'PLUGIN', detail: 'plugin p: no' });
  });
});

describe('B39: a string or a key counts max(1, ceil(w / 64)) nodes', () => {
  const nodesOf = (text: string): number => {
    const budget = new Budget('maxHookLeaves', 1_000_000);
    readBounded(text, DEFAULT_LIMITS, 'v', { budget });
    return budget.leaves;
  };
  it.each([
    ['', 1], // w = 2
    ['x', 1], // w = 3
    ['x'.repeat(62), 1], // w = 64
    ['x'.repeat(63), 2], // w = 65
    ['x'.repeat(126), 2], // w = 128
    ['x'.repeat(127), 3], // w = 129
    ['\n'.repeat(31), 1], // w = 64: each newline is written as two characters
    ['\n'.repeat(32), 2], // w = 66
  ])('%j weighs %i', (text, expected) => {
    expect(nodesOf(text)).toBe(expected);
  });
});

describe('B94: the text the engine writes is well-formed', () => {
  it('clip replaces a lone surrogate in a short text', () => {
    expect(clip('a\uD800')).toBe('a\uFFFD');
    expect(clip('fine')).toBe('fine');
  });

  it('a pointer in a limit error never holds a lone surrogate', () => {
    const limits = { ...DEFAULT_LIMITS, maxStringLength: 100 };
    const hostile = { [`k\uD800${'x'.repeat(200)}`]: 1 };
    let message = '';
    try {
      readBounded(hostile, limits, '/data', {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(hasLoneSurrogate(message)).toBe(false);
  });
});
