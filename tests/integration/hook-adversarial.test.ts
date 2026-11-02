import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { copyData } from '../../src/utils/values.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { ISnapshotAdapter, Snapshot } from '../../src/types/snapshot.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// A hook, a DSL, a model or a caller that cheats: what the engine evaluates is what it checked,
// and what it records is what it evaluated.

const FLAT = (rate: number): CalculationModel => ({
  name: 'FLAT',
  version: '1.0.0',
  validateParams: (params) =>
    typeof (params as { rate?: unknown }).rate === 'number'
      ? { valid: true }
      : { valid: false, errors: ['rate must be a number'] },
  calculate: (_input, _rule, params) => (params as { rate: number }).rate + rate * 0,
});

const host: PPEPlugin = {
  name: 'host',
  version: '1.0.0',
  onInit(context: PluginContext): void {
    context.modelRegistry.register(FLAT(0));
    context.modelRegistry.register(new StubModel('M', 10));
  },
};

function pluginWith(name: string, hooks: Partial<PPEPlugin>): PPEPlugin {
  return { name, version: '1.0.0', onInit: () => undefined, ...hooks };
}

interface Built {
  readonly engine: PPEEngine;
  readonly adapter: InMemorySnapshotAdapter;
}

function build(
  plugins: PPEPlugin[],
  config: Partial<PPEEngineConfig> = {},
  dsls: DSLEvaluator[] = [],
): Built {
  const adapter = new InMemorySnapshotAdapter();
  const engine = new PPEEngine({
    plugins: [host, ...plugins],
    dsls,
    strict: false,
    snapshot: adapter,
    ...config,
  });
  return { engine, adapter };
}

const tax = (rate = 100): Rule => makeRule({ id: 'tax', model: 'FLAT', params: { rate } });

async function failure(
  built: Built,
  rules: Rule[] = [tax()],
  input = makeInput(),
): Promise<unknown> {
  return built.engine.evaluate(rules, input).then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function expectHookFailure(
  error: unknown,
  message: string | RegExp,
): Promise<PluginHookError> {
  expect(error).toBeInstanceOf(PluginHookError);
  const cause = (error as PluginHookError).cause as Error;
  if (typeof message === 'string') expect(cause.message).toBe(message);
  else expect(cause.message).toMatch(message);
  return error as PluginHookError;
}

describe('N1: a hook cannot rewrite a given rule in place', () => {
  it('writing into a rule it was given throws: the rules are frozen copies', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          (rules[0] as { params: { rate: number } }).params.rate = 0;
          return { input, rules };
        },
      }),
    ]);
    const error = await failure(built);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(((error as PluginHookError).cause as Error).name).toBe('TypeError');
  });

  it('rewriting a copy and recomputing its checksum fails (finding 29)', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: rules.map((r) => makeRule({ ...r, params: { rate: 0 } })),
        }),
      }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin h rewrote rule tax@1: its content is not the one it was given',
    );
  });

  it('the bounds of a given rule are strings: nothing to move in place', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          expect(typeof rules[0]!.effectiveFrom).toBe('string');
          return { input, rules };
        },
      }),
    ]);
    expect(await failure(built)).toBeUndefined();
  });

  it("leaves the caller's rules and input untouched and unfrozen", async () => {
    const rules = [tax()];
    const input = makeInput({ data: { nest: { v: 1 }, list: [1, 2] } });
    const before = JSON.stringify([rules, input]);
    const built = build([pluginWith('h', { beforeEvaluate: (i, r) => ({ input: i, rules: r }) })]);
    await built.engine.evaluate(rules, input);
    expect(JSON.stringify([rules, input])).toBe(before);
    expect(Object.isFrozen(rules[0])).toBe(false);
    expect(Object.isFrozen(rules[0]!.params)).toBe(false);
    expect(Object.isFrozen(input.data)).toBe(false);
    expect(Object.isFrozen(input.data['nest'])).toBe(false);
  });

  it('the rules a hook returned are frozen for the next hook, which cannot rewrite them in place', async () => {
    const added = makeRule({ id: 'extra', model: 'FLAT', params: { rate: 5 } });
    const built = build([
      pluginWith('first', {
        beforeEvaluate: (input, rules) => ({ input, rules: [...rules, added] }),
      }),
      pluginWith('second', {
        beforeEvaluate: (input, rules) => {
          const extra = rules.find((r) => r.id === 'extra') as unknown as {
            params: { rate: number };
            checksum: string;
          };
          extra.params.rate = 0;
          return { input, rules };
        },
      }),
    ]);
    const error = await failure(built);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: 'second' });
    expect(((error as PluginHookError).cause as Error).name).toBe('TypeError');
  });

  it('a caller changing its rule while a hook is awaited changes nothing', async () => {
    const rule = tax();
    const built = build([
      pluginWith('h', {
        beforeEvaluate: async (input, rules) => {
          await Promise.resolve();
          (rule.params as { rate: number }).rate = 0;
          return { input, rules };
        },
      }),
    ]);
    const result = await built.engine.evaluate([rule], makeInput());
    expect(result.value).toBe(100);
  });
});

describe('N2: a hook cannot change the request', () => {
  it('requestId', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({ input: { ...input, requestId: 'dup' }, rules }),
      }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin h changed requestId from "test-request-001" to "dup"',
    );
  });

  it('meta.tenantId', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input: { ...input, meta: { ...input.meta, tenantId: 'other' } },
          rules,
        }),
      }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin h changed meta.tenantId from "tenant-1" to "other"',
    );
  });
});

describe('N3: the request id is read once', () => {
  it('a getter answering a different id at each read gives one id everywhere', async () => {
    const built = build([]);
    let reads = 0;
    const input = makeInput();
    Object.defineProperty(input, 'requestId', {
      enumerable: true,
      get: () => (++reads === 1 ? 'first' : `later-${reads}`),
    });
    const result = await built.engine.evaluate([tax()], input);
    expect(result.requestId).toBe('first');
    expect(await built.adapter.exists('first')).toBe(true);
    expect(reads).toBe(1);
  });
});

describe('N4: data, meta and their keys are read once', () => {
  it('a data getter answering differently the second time', () => {
    let reads = 0;
    const input = { requestId: 'r', meta: { tenantId: 't' } } as Record<string, unknown>;
    Object.defineProperty(input, 'data', {
      enumerable: true,
      get: () => (++reads <= 2 ? {} : { constructor: 1, prototype: 2 }),
    });
    const prepared = InputSanitizer.prepare(input);
    expect(prepared.input.data).toEqual({});
    expect(reads).toBe(1);
  });

  it('a meta Proxy whose second key listing adds __proto__ cannot give the copy a prototype', () => {
    let listings = 0;
    const meta = new Proxy({ tenantId: 't' } as Record<string, unknown>, {
      ownKeys(target) {
        listings += 1;
        return listings === 1 ? Reflect.ownKeys(target) : [...Reflect.ownKeys(target), '__proto__'];
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === '__proto__') {
          return { value: { tags: ['zz'] }, enumerable: true, configurable: true, writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key) {
        return key === '__proto__' ? { tags: ['zz'] } : Reflect.get(target, key);
      },
    });
    const prepared = InputSanitizer.prepare({ requestId: 'r', data: {}, meta });
    expect(Object.getPrototypeOf(prepared.input.meta)).toBe(Object.prototype);
    expect(prepared.input.meta.tags).toBeUndefined();
    expect(Object.keys(prepared.input.meta)).toEqual(['tenantId']);
  });
});

describe('N5: the evaluation copy is frozen and private', () => {
  it('prepare freezes the copy, at every depth, and copies the dates of meta', () => {
    const effective = new Date('2026-01-01T00:00:00Z');
    const prepared = InputSanitizer.prepare({
      requestId: 'r',
      data: { nest: { v: 1 }, list: [{ a: 1 }], none: {}, nothing: [] },
      meta: { tenantId: 't', effectiveDate: effective, tags: ['a'] },
    });
    const data = prepared.input.data as {
      nest: object;
      list: object[];
      none: object;
      nothing: object[];
    };
    expect(Object.isFrozen(prepared.input)).toBe(true);
    expect(Object.isFrozen(prepared.input.data)).toBe(true);
    expect(Object.isFrozen(data.nest)).toBe(true);
    expect(Object.isFrozen(data.list)).toBe(true);
    expect(Object.isFrozen(data.list[0])).toBe(true);
    expect(Object.isFrozen(data.none)).toBe(true);
    expect(Object.isFrozen(data.nothing)).toBe(true);
    expect(Object.isFrozen(prepared.input.meta)).toBe(true);
    expect(Object.isFrozen(prepared.input.meta.tags)).toBe(true);
    effective.setTime(0);
    expect(prepared.input.meta.effectiveDate?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('afterEvaluate writing into the input fails the evaluation', async () => {
    const built = build([
      pluginWith('h', {
        afterEvaluate: (input, result) => {
          (input.data as Record<string, unknown>)['revenue'] = 999;
          return result;
        },
      }),
    ]);
    const error = await failure(built, [tax()], makeInput({ data: { revenue: 100 } }));
    expect(error).toBeInstanceOf(PluginHookError);
    expect(((error as PluginHookError).cause as Error).name).toBe('TypeError');
    expect(await built.adapter.exists('test-request-001')).toBe(false);
  });

  it('beforeEvaluate writing into the input fails the evaluation', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          (input.data as Record<string, unknown>)['revenue'] = 999;
          return { input, rules };
        },
      }),
    ]);
    const error = await failure(built, [tax()], makeInput({ data: { revenue: 100 } }));
    expect(error).toBeInstanceOf(PluginHookError);
  });

  it('a hook moving a Date of meta cannot move the date the snapshot records', async () => {
    const saved: Snapshot[] = [];
    const adapter: ISnapshotAdapter = {
      save: async (snapshot) => {
        saved.push(snapshot);
        return snapshot.id;
      },
      get: async () => {
        throw new Error('unused');
      },
      exists: async () => false,
    };
    const built = build(
      [
        pluginWith('h', {
          afterEvaluate: (input, result) => {
            input.meta.effectiveDate?.setTime(0);
            return result;
          },
        }),
      ],
      { snapshot: adapter },
    );
    await built.engine.evaluate(
      [tax()],
      makeInput({ meta: { tenantId: 't', effectiveDate: new Date('2026-01-01T00:00:00Z') } }),
    );
    expect(saved[0]?.inputSnapshot.meta.effectiveDate?.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('a DSL writing into the context fails that rule only, with the reason', async () => {
    const writer: DSLEvaluator = {
      dsl: 'writer',
      version: '1.0.0',
      evaluate: (_e, context) => {
        (context['nest'] as { v: number }).v = 2 ** 60;
        return true;
      },
    };
    const built = build([], {}, [writer]);
    const result = await built.engine.evaluate(
      [tax(), makeRule({ id: 'bad', model: 'M', condition: { dsl: 'writer', value: null } })],
      makeInput({ data: { nest: { v: 1 } } }),
    );
    expect(result.appliedRules.map((r) => r.id)).toEqual(['tax']);
    const skip = result.skippedRules.find((s) => s.rule.id === 'bad');
    expect(skip?.reason).toBe('DSL_ERROR');
    expect(skip?.detail).toMatch(/wrote to its input/);
  });

  it('a model writing into the input data cannot change what the next model reads', async () => {
    const seen: unknown[] = [];
    const writer: CalculationModel = {
      name: 'W',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (input) => {
        try {
          (input['nest'] as { v: number }).v = 2 ** 60;
        } catch {
          // frozen: the write is refused
        }
        return 1;
      },
    };
    const reader: CalculationModel = {
      name: 'R',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (input) => {
        seen.push((input['nest'] as { v: number }).v);
        return 1;
      },
    };
    const reg = pluginWith('reg', {
      onInit(context: PluginContext): void {
        context.modelRegistry.register(writer);
        context.modelRegistry.register(reader);
      },
    });
    const built = build([reg]);
    await built.engine.evaluate(
      [
        makeRule({ id: 'a', model: 'W', priority: 200 }),
        makeRule({ id: 'b', model: 'R', priority: 100 }),
      ],
      makeInput({ data: { nest: { v: 1 } } }),
    );
    expect(seen).toEqual([1]);
  });
});

describe('N6: maxRules bounds the rules a hook returns', () => {
  it('a hook adding rules past the limit fails with an EngineLimitError', async () => {
    const built = build(
      [
        pluginWith('h', {
          beforeEvaluate: (input, rules) => ({
            input,
            rules: [...rules, ...[1, 2, 3, 4, 5].map((i) => makeRule({ id: `x${i}`, model: 'M' }))],
          }),
        }),
      ],
      { limits: { maxRules: 3 } },
    );
    const error = (await failure(built)) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).toBeInstanceOf(EngineLimitError);
    expect(error.cause).toMatchObject({ limit: 'maxRules', max: 3, actual: 6 });
  });

  it('a list of the limit passes', async () => {
    const built = build(
      [
        pluginWith('h', {
          beforeEvaluate: (input, rules) => ({
            input,
            rules: [...rules, makeRule({ id: 'x', model: 'M' })],
          }),
        }),
      ],
      { limits: { maxRules: 2 } },
    );
    expect(await failure(built)).toBeUndefined();
  });
});

describe('N7: a rule a hook adds is validated like a source rule', () => {
  it('params its model refuses', async () => {
    const bad = makeRule({ id: 'extra', model: 'FLAT', params: { rate: 'x' } });
    const built = build([
      pluginWith('h', { beforeEvaluate: (input, rules) => ({ input, rules: [...rules, bad] }) }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin h added rule extra@1: Invalid params for rule extra@1 (model FLAT): rate must be a number',
    );
  });
});

describe('N8 and N9: the rules and the skips of a hook are the given ones', () => {
  it('a given rule returned twice', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({ input, rules: [...rules, ...rules] }),
      }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin h returned rule tax@1 2 times (rules and skips together), it was given 1',
    );
  });

  it('a skip of a rule it was never given', async () => {
    const ghost = makeRule({ id: 'ghost', model: 'M' });
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules,
          skipped: [{ rule: ghost, reason: 'PLUGIN' }],
        }),
      }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin h skipped rule ghost@1, which it was not given',
    );
  });

  it('a rule both returned and skipped', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules,
          skipped: [{ rule: rules[0]!, reason: 'PLUGIN' }],
        }),
      }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin h returned rule tax@1 2 times (rules and skips together), it was given 1',
    );
  });

  it('a skip carrying a rewritten copy of a given rule', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [],
          skipped: [{ rule: { ...rules[0]!, params: { evil: true } } as Rule, reason: 'PLUGIN' }],
        }),
      }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin h skipped rule tax@1 with a content other than the one it was given',
    );
  });

  it('a given rule skipped once is accepted', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [],
          skipped: [{ rule: rules[0]!, reason: 'PLUGIN' }],
        }),
      }),
    ]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.skippedRules.map((s) => s.rule.id)).toEqual(['tax']);
    expect(result.appliedRules).toEqual([]);
  });
});

describe('N10: a sparse list costs one step', () => {
  it('a list of length 2^32 - 1 in data is refused at once', () => {
    const list: unknown[] = [];
    list.length = 2 ** 32 - 1;
    const started = Date.now();
    expect(() =>
      InputSanitizer.prepare({ requestId: 'r', data: { a: list }, meta: { tenantId: 't' } }),
    ).toThrow(ValidationError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('names the first hole', () => {
    const list = [1, 2];
    list.length = 5;
    try {
      InputSanitizer.prepare({ requestId: 'r', data: { a: list }, meta: { tenantId: 't' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ValidationError).reasons).toEqual([
        '/data/a has a hole at index 2: arrays must be dense',
      ]);
    }
  });

  it('copyData refuses a sparse list at once', () => {
    const list: unknown[] = [];
    list.length = 2 ** 32 - 1;
    const started = Date.now();
    expect(() => copyData({ a: list })).toThrow('a list with a hole at index 0');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a hook returning a sparse state fails the evaluation at once', async () => {
    const list: unknown[] = [];
    list.length = 2 ** 32 - 1;
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({ input, rules, state: list as never }),
      }),
    ]);
    const started = Date.now();
    expect(await failure(built)).toBeInstanceOf(PluginHookError);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('N11: meta.tags: null is not absence', () => {
  it('is refused by spec', () => {
    try {
      InputSanitizer.prepare({
        requestId: 'r',
        data: {},
        meta: { tenantId: 't', tags: null },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).reasons.join('|')).toContain('tags');
    }
  });
});

describe('N12: a __proto__ key of a hook result is kept', () => {
  it('copyData keeps a primitive and an object __proto__ as own keys', () => {
    const copy = copyData(JSON.parse('{"x":{"__proto__":5,"a":1},"y":{"__proto__":{"b":2}}}'));
    expect(Object.getOwnPropertyDescriptor(copy.x, '__proto__')?.value).toBe(5);
    expect(Object.getOwnPropertyDescriptor(copy.y, '__proto__')?.value).toEqual({ b: 2 });
    expect(Object.getPrototypeOf(copy.y)).toBe(Object.prototype);
  });

  it('a state with a __proto__ key reaches pluginState intact', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules,
          state: JSON.parse('{"__proto__":5,"a":1}') as never,
        }),
      }),
    ]);
    const result = await built.engine.evaluate([tax()], makeInput());
    const state = result.pluginState['h'] as object;
    expect(Object.getOwnPropertyDescriptor(state, '__proto__')?.value).toBe(5);
  });
});

describe("N13: a plugin cannot change another plugin's meta keys", () => {
  const setter = (name: string, meta: Record<string, unknown>): PPEPlugin =>
    pluginWith(name, {
      afterEvaluate: (_input, result) => ({ ...result, meta: { ...result.meta, ...meta } }),
    });

  it('adding a key is allowed', async () => {
    const built = build([setter('a', { a: 'audit-ok' }), setter('b', { b: 'x' })]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.meta).toEqual({ a: 'audit-ok', b: 'x' });
  });

  it('replacing a key fails', async () => {
    const built = build([
      setter('a', { a: 'audit-ok' }),
      pluginWith('b', {
        afterEvaluate: (_i, result) => ({ ...result, meta: { ...result.meta, a: 'changed' } }),
      }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin b afterEvaluate changed meta keys another plugin set: a',
    );
  });

  it('removing the meta fails', async () => {
    const built = build([
      setter('a', { a: 'audit-ok' }),
      pluginWith('b', { afterEvaluate: (_i, result) => ({ ...result, meta: { b: 'x' } }) }),
    ]);
    await expectHookFailure(
      await failure(built),
      'plugin b afterEvaluate changed meta keys another plugin set: a',
    );
  });
});

describe('N14, N15, N16: what cannot be read, or would vanish, is named', () => {
  const prepared = (data: unknown, meta: Record<string, unknown> = {}): unknown => {
    try {
      InputSanitizer.prepare({ requestId: 'r', data, meta: { tenantId: 't', ...meta } });
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('N14: a meta member that cannot be read', () => {
    const meta: Record<string, unknown> = { tenantId: 't' };
    Object.defineProperty(meta, 'dates', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    let error: unknown;
    try {
      InputSanitizer.prepare({ requestId: 'r', data: {}, meta });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ reasons: ['/meta/dates could not be read: boom'] });
  });

  it.each([-1, 2 ** 53, 'x'])('N15: a list whose length is %j', (length) => {
    const list = new Proxy([1], {
      get: (target, key) => (key === 'length' ? length : Reflect.get(target, key)),
    });
    expect(prepared({ a: list })).toMatchObject({
      reasons: [expect.stringMatching(/^\/data\/a could not be read: /)],
    });
  });

  it('N16: a symbol key', () => {
    expect(prepared({ [Symbol('s')]: 1, a: 1 })).toMatchObject({
      reasons: ['/data has a symbol key: Symbol(s)'],
    });
  });

  it('N16: a non-enumerable property', () => {
    const data = { a: 1 };
    Object.defineProperty(data, 'hidden', { value: 2, enumerable: false });
    expect(prepared({ nest: data })).toMatchObject({
      reasons: ['/data/nest/hidden is not enumerable'],
    });
  });
});

describe('an input a hook returns that is not an input', () => {
  it("data that is not an object fails with the sanitizer's reason as the cause", async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({ input: { ...input, data: 5 as never }, rules }),
      }),
    ]);
    const error = (await failure(built)) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).toBeInstanceOf(ValidationError);
    expect((error.cause as ValidationError).reasons).toEqual(['data must be a non-null object']);
  });
});
