import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { InputCopier } from '../../src/input/copyInput.js';
import { resolveLimits } from '../../src/limits.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { ISnapshotAdapter, Snapshot } from '../../src/types/snapshot.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// The plugin trust boundary, replayed probe by probe (rounds 1 to 3 of the 9L audit). Every probe
// asserts the exact failure, or that the decision and the record are untouched.

const FLAT: CalculationModel = {
  name: 'FLAT',
  version: '1.0.0',
  validateParams: (params) =>
    typeof (params as { rate?: unknown }).rate === 'number'
      ? { valid: true }
      : { valid: false, errors: ['rate must be a number'] },
  calculate: (_input, _rule, params) => (params as { rate: number }).rate,
};

const host: PPEPlugin = {
  name: 'host',
  version: '1.0.0',
  onInit(context: PluginContext): void {
    context.modelRegistry.register(FLAT);
    context.modelRegistry.register(new StubModel('M', 10));
  },
};

const pluginWith = (name: string, hooks: Partial<PPEPlugin>): PPEPlugin => ({
  name,
  version: '1.0.0',
  onInit: () => undefined,
  ...hooks,
});

interface Built {
  readonly engine: PPEEngine;
  readonly adapter: InMemorySnapshotAdapter;
  readonly saved: Snapshot[];
}

function build(
  plugins: PPEPlugin[],
  config: Partial<PPEEngineConfig> = {},
  dsls: DSLEvaluator[] = [],
): Built {
  const inner = new InMemorySnapshotAdapter();
  const saved: Snapshot[] = [];
  const adapter: ISnapshotAdapter = {
    save: async (snapshot) => {
      saved.push(snapshot);
      return inner.save(snapshot);
    },
    get: (id) => inner.get(id),
    exists: (id) => inner.exists(id),
  };
  const engine = new PPEEngine({
    plugins: [host, ...plugins],
    dsls,
    strict: false,
    snapshot: adapter,
    ...config,
  });
  return { engine, adapter: inner, saved };
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

/** A PluginHookError of `plugin`, nothing saved. */
async function expectHookFailure(
  built: Built,
  error: unknown,
  plugin = 'h',
): Promise<PluginHookError> {
  expect(error).toBeInstanceOf(PluginHookError);
  expect(error).toMatchObject({ plugin });
  expect(built.saved).toEqual([]);
  expect(await built.adapter.exists('test-request-001')).toBe(false);
  return error as PluginHookError;
}

const noop = pluginWith('first', { beforeEvaluate: (input, rules) => ({ input, rules }) });

describe('R1: the array of given rules is not writable and is not read back', () => {
  const mutations: [string, (rules: Rule[]) => void][] = [
    ['replace a rule', (rules) => void (rules[0] = tax(0))],
    [
      'push a valid rule',
      (rules) => void rules.push(makeRule({ id: 'sneak', model: 'FLAT', params: { rate: 7 } })),
    ],
    [
      'push a rule with refused params',
      (rules) => void rules.push(makeRule({ id: 'bad', model: 'FLAT', params: { rate: 'x' } })),
    ],
    ['push a duplicate', (rules) => void rules.push(rules[0]!)],
    ['truncate the list', (rules) => void (rules.length = 0)],
  ];
  for (const [label, mutate] of mutations) {
    it(`${label}, on the first hook`, async () => {
      const built = build([
        pluginWith('h', {
          beforeEvaluate: (input, rules) => {
            mutate(rules as Rule[]);
            return { input, rules };
          },
        }),
      ]);
      await expectHookFailure(built, await failure(built));
    });
    it(`${label}, on a later hook`, async () => {
      const built = build([
        noop,
        pluginWith('h', {
          beforeEvaluate: (input, rules) => {
            mutate(rules as Rule[]);
            return { input, rules };
          },
        }),
      ]);
      await expectHookFailure(built, await failure(built));
    });
  }

  it('hands the hook a view it cannot use to change what the engine holds, even in sloppy code', async () => {
    // A sloppy-mode write is ignored on a frozen array; the decision must be the source's.
    const built = build([
      pluginWith('h', {
        beforeEvaluate: new Function(
          'input',
          'rules',
          'try { rules[0] = null; rules.push(null); rules.length = 0; } catch (e) {} return { input, rules };',
        ) as never,
      }),
    ]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.value).toBe(100);
    expect(result.appliedRules.map((r) => r.id)).toEqual(['tax']);
  });
});

describe('R2: the dates of a rule cannot be moved by a model or a hook', () => {
  it('a model writing the bound of its rule is excluded, and the record keeps the bound', async () => {
    const mover: CalculationModel = {
      name: 'MOVER',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (_input, rule) => {
        (rule as { effectiveFrom: unknown }).effectiveFrom = '2099-01-01';
        return 7;
      },
    };
    const built = build([pluginWith('reg', { onInit: (c) => c.modelRegistry.register(mover) })]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'm', model: 'MOVER' }), makeRule({ id: 'ok', model: 'M' })],
      makeInput({ meta: { tenantId: 't', effectiveDate: new Date('2024-06-01T00:00:00Z') } }),
    );
    expect(result.appliedRules.map((r) => r.id)).toEqual(['ok']);
    const skip = result.skippedRules.find((s) => s.rule.id === 'm');
    expect(skip).toMatchObject({
      reason: 'MODEL_ERROR',
      detail: 'wrote to its input: effectiveFrom',
    });
    expect(skip?.rule.effectiveFrom).toBe('2024-01-01T00:00:00.000Z');
  });

  it('a hook cannot write the bound of a rule it was given: it is a string, in a frozen rule', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          (rules[0] as { effectiveFrom: unknown }).effectiveFrom = '1970-01-01';
          return { input, rules };
        },
      }),
    ]);
    await expectHookFailure(built, await failure(built));
  });
});

describe('R3: $dimensions cannot be rewritten by a DSL', () => {
  it("the write is that rule's DSL_ERROR, and the next rule keeps its dimension", async () => {
    const writer: DSLEvaluator = {
      dsl: 'writer',
      version: '1.0.0',
      evaluate: (_e, context) => {
        const region = (context['$dimensions'] as { region: string[] }).region;
        region.length = 0;
        region.push('XX');
        return true;
      },
    };
    const built = build([], {}, [writer]);
    const result = await built.engine.evaluate(
      [
        makeRule({ id: 'a', model: 'M', priority: 300, condition: { dsl: 'writer', value: null } }),
        makeRule({ id: 'b', model: 'M', priority: 100, dimensions: { region: 'TG' } }),
      ],
      makeInput({ meta: { tenantId: 't', dimensions: { region: ['TG', 'BJ'] } } }),
    );
    expect(result.appliedRules.map((r) => r.id)).toEqual(['b']);
    expect(result.skippedRules.find((s) => s.rule.id === 'a')?.reason).toBe('DSL_ERROR');
    expect(built.saved[0]!.inputSnapshot.meta.dimensions).toEqual({ region: ['TG', 'BJ'] });
  });
});

describe('R4: a label that left the evaluation cannot come back with other content', () => {
  const skipTax = pluginWith('a', {
    beforeEvaluate: (input, rules) => ({
      input,
      rules: [],
      skipped: [{ rule: rules[0]!, reason: 'PLUGIN' as never }],
    }),
  });
  it('a label skipped by an earlier plugin', async () => {
    const built = build([
      skipTax,
      pluginWith('h', { beforeEvaluate: (input, rules) => ({ input, rules: [...rules, tax(0)] }) }),
    ]);
    await expectHookFailure(built, await failure(built));
  });
  it('a source rule refused for its params, re-added with good ones', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [...rules, makeRule({ id: 'x', model: 'FLAT', params: { rate: 5 } })],
        }),
      }),
    ]);
    const error = await failure(built, [
      makeRule({ id: 'x', model: 'FLAT', params: { rate: 'bad' } }),
    ]);
    await expectHookFailure(built, error);
  });
  it('a source rule with a tampered checksum, re-added', async () => {
    const tampered = { ...tax(), checksum: 'f'.repeat(64) } as Rule;
    const built = build([
      pluginWith('h', { beforeEvaluate: (input, rules) => ({ input, rules: [...rules, tax(5)] }) }),
    ]);
    await expectHookFailure(built, await failure(built, [tampered]));
  });
});

describe('R5: given rules sharing a label cannot be swapped', () => {
  it('two contents under one id@version, one returned twice', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({ input, rules: [rules[0]!, rules[0]!] }),
      }),
    ]);
    await expectHookFailure(built, await failure(built, [tax(100), tax(5)]));
  });
  it('without a hook the two contents are both evaluated (control)', async () => {
    const built = build([]);
    const result = await built.engine.evaluate([tax(100), tax(5)], makeInput());
    expect(result.value).toBe(105);
  });
});

describe('R6: what a hook returns is read once and bounded', () => {
  it('a Proxy whose length shrinks after the first read cannot pass maxRules', async () => {
    const rules = [1, 2, 3, 4, 5, 6].map((i) => makeRule({ id: `r${i}`, model: 'M' }));
    let reads = 0;
    const proxy = new Proxy(rules, {
      get(target, key, receiver) {
        if (key === 'length') return ++reads === 1 ? 1 : Reflect.get(target, key, receiver);
        return Reflect.get(target, key, receiver);
      },
    });
    const built = build(
      [pluginWith('h', { beforeEvaluate: (input) => ({ input, rules: proxy }) })],
      { limits: { maxRules: 3 } },
    );
    // The length is read once: the engine sees one rule and no more, never the six.
    const result = await built.engine.evaluate([makeRule({ id: 'r1', model: 'M' })], makeInput());
    expect(result.appliedRules.map((r) => r.id)).toEqual(['r1']);
    expect(reads).toBe(1);
  });

  it('a list longer than maxRules is refused with the limit', async () => {
    const rules = [1, 2, 3, 4].map((i) => makeRule({ id: `r${i}`, model: 'M' }));
    const built = build([pluginWith('h', { beforeEvaluate: (input) => ({ input, rules }) })], {
      limits: { maxRules: 3 },
    });
    const error = await expectHookFailure(built, await failure(built, [rules[0]!]));
    expect(error.cause).toMatchObject({ limit: 'maxRules', max: 3, actual: 4 });
  });

  it('a Proxy whose length keeps growing is stopped, quickly', async () => {
    let length = 0;
    const proxy = new Proxy([] as unknown[], {
      get(target, key, receiver) {
        if (key === 'length') return (length += 1);
        return Reflect.get(target, key, receiver);
      },
      has: () => true,
      getOwnPropertyDescriptor: () => ({
        value: 1,
        enumerable: true,
        configurable: true,
        writable: true,
      }),
    });
    const built = build([
      pluginWith('h', { beforeEvaluate: (input) => ({ input, rules: proxy as never }) }),
    ]);
    const started = Date.now();
    await expectHookFailure(built, await failure(built));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('R7 and R8: the keys are listed once, on every object', () => {
  const prepare = (input: unknown): unknown => {
    try {
      return InputSanitizer.prepare(input);
    } catch (error) {
      return error;
    }
  };

  it('R7: a data Proxy whose second listing adds forbidden keys', () => {
    let listings = 0;
    const data = new Proxy({ ok: 1 } as Record<string, unknown>, {
      ownKeys(target) {
        listings += 1;
        return listings === 1
          ? Reflect.ownKeys(target)
          : [...Reflect.ownKeys(target), 'constructor', 'prototype'];
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === 'constructor' || key === 'prototype') {
          return { value: 1, enumerable: true, configurable: true, writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = prepare({ requestId: 'r', data, meta: { tenantId: 't' } });
    if (result instanceof Error) {
      expect(result).toBeInstanceOf(ValidationError);
    } else {
      const prepared = result as ReturnType<typeof InputSanitizer.prepare>;
      expect(Object.keys(prepared.input.data)).not.toContain('constructor');
    }
  });

  it('R8: a non-enumerable meta.effectiveDate is refused, not dropped', () => {
    const meta: Record<string, unknown> = { tenantId: 't' };
    Object.defineProperty(meta, 'effectiveDate', {
      value: new Date('2000-01-01'),
      enumerable: false,
    });
    expect(prepare({ requestId: 'r', data: {}, meta })).toMatchObject({
      reasons: ['/meta/effectiveDate is not enumerable'],
    });
  });

  it('R8: a symbol key on meta is refused', () => {
    const meta: Record<string | symbol, unknown> = { tenantId: 't', [Symbol('s')]: 1 };
    expect(prepare({ requestId: 'r', data: {}, meta })).toMatchObject({
      reasons: ['/meta has a symbol key: Symbol(s)'],
    });
  });

  it('R8: an unknown key at the root of the input is refused by name', () => {
    expect(prepare({ requestId: 'r', data: {}, meta: { tenantId: 't' }, extra: 1 })).toMatchObject({
      reasons: ['input has an unknown key "extra"'],
    });
  });

  it('R8: a symbol key at the root of the input is refused', () => {
    const input: Record<string | symbol, unknown> = {
      requestId: 'r',
      data: {},
      meta: { tenantId: 't' },
    };
    input[Symbol('s')] = 1;
    expect(prepare(input)).toMatchObject({ reasons: ['input has a symbol key: Symbol(s)'] });
  });
});

describe('R9: a plugin skip has the exact shape and a plugin reason', () => {
  const skipWith = (skip: (rule: Rule) => unknown): PPEPlugin =>
    pluginWith('h', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [],
        skipped: [skip(rules[0]!)] as never,
      }),
    });

  it('an invented reason', async () => {
    const built = build([skipWith((rule) => ({ rule, reason: 'TOTALLY_MADE_UP' }))]);
    const error = await expectHookFailure(built, await failure(built));
    expect((error.cause as Error).message).toMatch(/reason/);
  });
  it('an engine-owned reason', async () => {
    const built = build([
      skipWith((rule) => ({ rule, reason: 'CHECKSUM_MISMATCH', detail: 'tampered' })),
    ]);
    await expectHookFailure(built, await failure(built));
  });
  it('an extra key', async () => {
    const built = build([skipWith((rule) => ({ rule, reason: 'PLUGIN', evil: { x: 1 } }))]);
    await expectHookFailure(built, await failure(built));
  });
  it("a plugin reason is recorded, with the plugin's words", async () => {
    const built = build([skipWith((rule) => ({ rule, reason: 'PLUGIN', detail: 'my words' }))]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
      ['tax', 'PLUGIN', 'plugin h: my words'],
    ]);
    expect(Object.isFrozen(result.skippedRules[0])).toBe(true);
  });
});

describe('R10: the meta an afterEvaluate returns is JSON', () => {
  const setMeta = (meta: unknown): PPEPlugin =>
    pluginWith('h', {
      afterEvaluate: (_input, result) => ({ ...result, meta }) as never,
    });
  for (const [label, value, path] of [
    ['a function', () => 1, '$.m'],
    ['a Map', new Map(), '$.m'],
    ['a BigInt', 1n, '$.m'],
    ['NaN', NaN, '$.m'],
  ] as const) {
    it(`refuses ${label}, naming the plugin and the path`, async () => {
      const built = build([setMeta({ m: value })]);
      const error = await expectHookFailure(built, await failure(built));
      expect(error.hook).toBe('afterEvaluate');
      expect((error.cause as Error).message).toMatch(
        new RegExp(`meta that is not JSON at \\$\\.m`),
      );
      void path;
    });
  }
});

describe('R11: an object that cannot be read is named, not a raw TypeError', () => {
  const prepare = (data: unknown, meta: Record<string, unknown> = {}): unknown => {
    try {
      return InputSanitizer.prepare({ requestId: 'r', data, meta: { tenantId: 't', ...meta } });
    } catch (error) {
      return error;
    }
  };
  const revoked = (): object => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  };
  it('a revoked Proxy in data', () => {
    expect(prepare({ x: revoked() })).toMatchObject({
      reasons: [expect.stringMatching(/^\/data\/x could not be read: /)],
    });
  });
  it('a revoked Proxy as meta.context', () => {
    expect(prepare({}, { context: revoked() })).toMatchObject({
      reasons: [expect.stringMatching(/^\/meta\/context could not be read: /)],
    });
  });
  it('a fake Date', () => {
    expect(prepare({}, { dates: { x: Object.create(Date.prototype) } })).toBeInstanceOf(
      ValidationError,
    );
    expect(prepare({}, { effectiveDate: new Proxy(new Date(), {}) })).toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("R12: a model that writes into its arguments is that rule's error", () => {
  it('is an exclusion with a named reason, and the other rules go on', async () => {
    const writer: CalculationModel = {
      name: 'W',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (_input, rule) => {
        (rule.params as Record<string, unknown>)['x'] = 5;
        return 1;
      },
    };
    const built = build([pluginWith('reg', { onInit: (c) => c.modelRegistry.register(writer) })]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'w', model: 'W' }), makeRule({ id: 'ok', model: 'M' })],
      makeInput(),
    );
    expect(result.appliedRules.map((r) => r.id)).toEqual(['ok']);
    const skip = result.skippedRules.find((s) => s.rule.id === 'w');
    expect(skip?.reason).toBe('MODEL_ERROR');
    expect(skip?.detail).toMatch(/^wrote to its input: /);
  });
});

describe('R13 and R16: what a hook is handed is a view', () => {
  it("beforeEvaluate moving the dates of its view fails (meta is the caller's), and does not move the caller's", async () => {
    const dates = { facture: new Date('2025-01-01T00:00:00Z') };
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          (input.meta.dates?.['facture'] as Date).setTime(0);
          input.meta.effectiveDate?.setTime(0);
          return { input, rules };
        },
      }),
    ]);
    const effectiveDate = new Date('2024-06-01T00:00:00Z');
    const error = await failure(
      built,
      [tax()],
      makeInput({ meta: { tenantId: 't', dates, effectiveDate } }),
    );
    expect(error).toBeInstanceOf(PluginHookError);
    expect(dates.facture.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(effectiveDate.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('afterEvaluate gets its own copy of meta.dates: moving it changes the record not', async () => {
    const built = build([
      pluginWith('h', {
        afterEvaluate: (input, result) => {
          (input.meta.dates?.['facture'] as Date).setTime(0);
          return result;
        },
      }),
    ]);
    await built.engine.evaluate(
      [tax()],
      makeInput({ meta: { tenantId: 't', dates: { facture: new Date('2025-01-01T00:00:00Z') } } }),
    );
    const recorded = built.saved[0]!.inputSnapshot.meta.dates?.['facture'];
    expect((recorded as Date).toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('the view is frozen at its root and at meta', async () => {
    let writes = 0;
    const built = build([
      pluginWith('h', {
        afterEvaluate: (input, result) => {
          for (const target of [input, input.meta]) {
            try {
              (target as unknown as Record<string, unknown>)['x'] = 1;
            } catch {
              writes += 1;
            }
          }
          return result;
        },
      }),
    ]);
    await built.engine.evaluate([tax()], makeInput());
    expect(writes).toBe(2);
  });

  it('tenantId comes from the copy: a getter answering differently is read once', async () => {
    let reads = 0;
    const meta: Record<string, unknown> = {};
    Object.defineProperty(meta, 'tenantId', {
      enumerable: true,
      get: () => (++reads === 1 ? 'first' : 'later'),
    });
    const built = build([noop]);
    await built.engine.evaluate([tax()], makeInput({ meta: meta as never }));
    expect(built.saved[0]!.tenantId).toBe('first');
    expect(built.saved[0]!.inputSnapshot.meta.tenantId).toBe('first');
  });

  it('the skips a hook returns are frozen in the result', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [],
          skipped: [{ rule: rules[0]!, reason: 'PLUGIN' as never }],
        }),
      }),
    ]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(Object.isFrozen(result.skippedRules[0])).toBe(true);
    expect(Object.isFrozen(result.skippedRules[0]!.rule)).toBe(true);
  });
});

describe('R14 and R15: what the caller holds, and what the result holds', () => {
  it('a non-plain object inside a source rule is not frozen', async () => {
    class Box {
      v = 1;
    }
    const box = new Box();
    const built = build([]);
    // Spec cannot checksum a class instance: the rule is refused, and the box stays the caller's.
    const rule = { ...tax(), params: { rate: 1, box } } as Rule;
    const result = await built.engine.evaluate([rule], makeInput());
    expect(result.skippedRules.map((s) => s.reason)).toEqual(['INVALID_RULE']);
    expect(Object.isFrozen(box)).toBe(false);
  });

  it('the rules of the result are frozen (documented)', async () => {
    const built = build([]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(Object.isFrozen(result.appliedRules[0])).toBe(true);
    expect(Object.isFrozen(result.appliedRules[0]!.params)).toBe(true);
  });
});

describe('R16: the copier reports its own holes', () => {
  it('names the first hole and stops the list', () => {
    const copier = new InputCopier(resolveLimits());
    const list = [1, 2];
    list.length = 4;
    copier.copy({ a: list }, '/data');
    expect(copier.reasons).toEqual(['/data/a has a hole at index 2: arrays must be dense']);
  });
});

describe('R18: what a hook returns is bounded in size and depth', () => {
  it('a state of 2 000 000 items is refused with the limit', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules,
          state: new Array(2_000_000).fill(1) as never,
        }),
      }),
    ]);
    const error = await expectHookFailure(built, await failure(built));
    expect(error.cause).toBeInstanceOf(EngineLimitError);
    expect(error.cause).toMatchObject({ limit: 'maxInputLeaves' });
  });

  it('a state 20 000 levels deep is refused with the limit, not a stack overflow', async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i += 1) deep = [deep];
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({ input, rules, state: deep as never }),
      }),
    ]);
    const error = await expectHookFailure(built, await failure(built));
    expect(error.cause).toBeInstanceOf(EngineLimitError);
    expect(error.cause).toMatchObject({ limit: 'maxInputDepth' });
  });

  it('a source rule 20 000 levels deep is refused with the limit', async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i += 1) deep = { a: deep };
    const built = build([]);
    const error = await failure(built, [{ ...tax(), params: { rate: 1, deep } } as Rule]);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxInputDepth' });
  });
});

describe('survivors of the third review (R16) and the views', () => {
  it('the lists inside a rule view are frozen', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          (rules[0]!.tags as string[]).push('x');
          return { input, rules };
        },
      }),
    ]);
    const error = await failure(built);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(((error as PluginHookError).cause as Error).name).toBe('TypeError');
  });

  it('a list of rules with a hole is refused, naming the index', async () => {
    const sparse: unknown[] = [tax()];
    sparse[2] = tax(5);
    const built = build([
      pluginWith('h', { beforeEvaluate: (input) => ({ input, rules: sparse as never }) }),
    ]);
    const error = await expectHookFailure(built, await failure(built));
    expect((error.cause as Error).message).toBe('rules has a hole at index 1: lists must be dense');
  });

  it('the result an afterEvaluate returns is bounded in size', async () => {
    const built = build([
      pluginWith('h', {
        afterEvaluate: (_input, result) => ({
          ...result,
          trace: {
            ...result.trace,
            steps: [...result.trace.steps, { big: new Array(2_000_000).fill(1) } as never],
          },
        }),
      }),
    ]);
    const error = await expectHookFailure(built, await failure(built));
    expect(error.cause).toBeInstanceOf(EngineLimitError);
    expect(error.cause).toMatchObject({ limit: 'maxInputLeaves' });
  });

  it('the forbidden keys of data are looked for on the copy, not on a later listing', () => {
    let listings = 0;
    const data = new Proxy({ ok: 1, constructor: 2 } as Record<string, unknown>, {
      ownKeys(target) {
        listings += 1;
        return listings === 1
          ? ['ok', 'constructor']
          : Reflect.ownKeys(target).filter((k) => k === 'ok');
      },
      getOwnPropertyDescriptor(target, key) {
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(() => InputSanitizer.prepare({ requestId: 'r', data, meta: { tenantId: 't' } })).toThrow(
      ValidationError,
    );
  });

  it('the tenant is checked on the copy: a getter answering "x" and then "" is "x"', () => {
    let reads = 0;
    const meta: Record<string, unknown> = {};
    Object.defineProperty(meta, 'tenantId', {
      enumerable: true,
      get: () => (++reads === 1 ? 'x' : ''),
    });
    const prepared = InputSanitizer.prepare({ requestId: 'r', data: {}, meta });
    expect(prepared.input.meta.tenantId).toBe('x');
  });
});

describe('maxRuleLeaves: the leaves of one rule', () => {
  /** The leaves of a rule as the engine counts them. */
  const leavesOfRule = (rule: Rule): number => {
    const copier = new InputCopier({ ...resolveLimits(), maxInputLeaves: Number.MAX_SAFE_INTEGER });
    copier.copy(rule, 'rule');
    return copier.leaves;
  };

  it('a source rule of exactly the limit passes, one leaf more is refused with the limit', async () => {
    const rule = tax();
    const leaves = leavesOfRule(rule);
    const ok = build([], { limits: { maxRuleLeaves: leaves } });
    expect((await ok.engine.evaluate([rule], makeInput())).value).toBe(100);
    const refused = build([], { limits: { maxRuleLeaves: leaves - 1 } });
    const error = await failure(refused, [rule]);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRuleLeaves', max: leaves - 1, actual: leaves });
  });

  it('a rule a hook returns is held to the same limit', async () => {
    const rule = tax();
    const leaves = leavesOfRule(rule);
    const built = build(
      [pluginWith('h', { beforeEvaluate: (input) => ({ input, rules: [rule] }) })],
      { limits: { maxRuleLeaves: leaves } },
    );
    expect(await failure(built, [rule])).toBeUndefined();
    const bigger = { ...rule, params: { rate: 100, pad: [1] } } as Rule;
    const built2 = build(
      [pluginWith('h', { beforeEvaluate: (input) => ({ input, rules: [bigger] }) })],
      { limits: { maxRuleLeaves: leaves } },
    );
    const error = (await failure(built2, [rule])) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).toMatchObject({ limit: 'maxRuleLeaves', max: leaves });
  });

  it('is refused at construction when it is not a positive integer', () => {
    expect(
      () => new PPEEngine({ plugins: [host], dsls: [], limits: { maxRuleLeaves: 0 } }),
    ).toThrow(ValidationError);
  });
});
