import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { resolveLimits } from '../../src/limits.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { ISnapshotAdapter, Snapshot } from '../../src/types/snapshot.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Round 4 of the 9L audit (S1 to S16): one definition of plain, nothing kept by reference, one
// bound for what a hook returns, no Date in the engine, writes trapped, registries fixed per
// evaluation. Every probe asserts the exact failure, or that a later change has no effect.

const FLAT: CalculationModel = {
  name: 'flat',
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
    context.modelRegistry.register(new StubModel('m', 10));
  },
};
const pluginWith = (name: string, hooks: Partial<PPEPlugin>): PPEPlugin => ({
  name,
  version: '1.0.0',
  onInit: () => undefined,
  ...hooks,
});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** A hook that takes a while (a hook may be async; a DSL may not). */
const slowHook: PPEPlugin = {
  name: 'slowhook',
  version: '1.0.0',
  onInit: () => undefined,
  beforeEvaluate: async (input, rules) => {
    await sleep(30);
    return { input, rules };
  },
};

interface Built {
  readonly engine: PPEEngine;
  readonly saved: Snapshot[];
  readonly adapter: InMemorySnapshotAdapter;
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
  return { engine, saved, adapter: inner };
}
const tax = (rate = 100): Rule => makeRule({ id: 'tax', model: 'flat', params: { rate } });
async function failure(
  built: Built,
  rules: unknown,
  input: unknown = makeInput(),
): Promise<unknown> {
  return built.engine.evaluate(rules as Rule[], input as never).then(
    () => undefined,
    (error: unknown) => error,
  );
}
const foreign = <T>(source: string): T => vm.runInNewContext(source) as T;
const prepare = (input: unknown, limits = resolveLimits()): unknown => {
  try {
    return InputSanitizer.prepare(input, limits);
  } catch (error) {
    return error;
  }
};

describe('S1: nothing is kept by reference; one definition of plain', () => {
  it('foreign-realm data is copied, frozen and counted', () => {
    const data = foreign<Record<string, unknown>>('({ amount: 5 })');
    const prepared = prepare({ requestId: 'r', data, meta: { tenantId: 't' } }) as {
      input: { data: Record<string, unknown> };
    };
    expect(prepared.input.data).not.toBe(data);
    expect(Object.isFrozen(prepared.input.data)).toBe(true);
    expect(prepared.input.data).toEqual({ amount: 5 });
  });

  it('foreign data past the leaf bound is refused (A0b)', () => {
    const data = foreign<Record<string, unknown>>(
      'const o = {}; for (let i = 0; i < 1000; i++) o["k" + i] = i; o',
    );
    expect(
      prepare(
        { requestId: 'r', data, meta: { tenantId: 't' } },
        resolveLimits({ maxInputLeaves: 10 }),
      ),
    ).toBeInstanceOf(EngineLimitError);
  });

  it('foreign data past the depth bound is refused (A0c)', () => {
    const data = foreign<Record<string, unknown>>(
      'let v = { leaf: 1 }; for (let i = 0; i < 300; i++) v = { a: v }; v',
    );
    expect(prepare({ requestId: 'r', data, meta: { tenantId: 't' } })).toBeInstanceOf(
      EngineLimitError,
    );
  });

  it('A1: a caller changing foreign data while a hook is awaited changes nothing', async () => {
    const data = foreign<Record<string, unknown>>('({ amount: 5 })');
    const reader: CalculationModel = {
      name: 'read',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (input) => input['amount'] as number,
    };
    const built = build([
      pluginWith('reg', { onInit: (c) => c.modelRegistry.register(reader) }),
      pluginWith('h', {
        beforeEvaluate: async (input, rules) => {
          await sleep(5);
          data['amount'] = 999;
          return { input, rules };
        },
      }),
    ]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'r', model: 'read' })],
      makeInput({ data }),
    );
    expect(result.value).toBe(5);
    expect((built.saved[0]!.inputSnapshot.data as { amount: number }).amount).toBe(5);
  });

  it('A2: a hook writing into its view of foreign data fails or changes nothing', async () => {
    const data = foreign<Record<string, unknown>>('({ amount: 5 })');
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          (input.data as Record<string, unknown>)['amount'] = 777;
          return { input, rules };
        },
      }),
    ]);
    const error = await failure(built, [tax()], makeInput({ data }));
    expect(error).toBeInstanceOf(PluginHookError);
  });

  it('A4b: a foreign source rule changed by the caller during a hook await keeps its checked content', async () => {
    const rule = foreign<Rule>(
      `({ id: 'tax', version: 1, model: 'flat', priority: 100, tags: [], params: { rate: 5 }, effectiveFrom: '2024-01-01', effectiveUntil: null, checksum: '' })`,
    );
    const good = makeRule({
      id: 'tax',
      model: 'flat',
      params: { rate: 5 },
      effectiveFrom: '2024-01-01' as never,
    });
    (rule as { checksum: string }).checksum = good.checksum;
    const built = build([slowHook]);
    const pending = built.engine.evaluate([rule], makeInput());
    setTimeout(() => ((rule.params as { rate: number }).rate = 999), 5);
    const result = await pending;
    expect(result.value).toBe(5);
    expect((result.appliedRules[0]!.params as { rate: number }).rate).toBe(5);
  });

  it('A5b: a foreign rule a hook adds and later changes keeps its validated content', async () => {
    const add = foreign<Rule>(
      `({ id: 'add', version: 1, model: 'flat', priority: 90, tags: [], params: { rate: 7 }, effectiveFrom: '2024-01-01', effectiveUntil: null, checksum: '' })`,
    );
    (add as { checksum: string }).checksum = makeRule({
      id: 'add',
      model: 'flat',
      priority: 90,
      params: { rate: 7 },
      effectiveFrom: '2024-01-01' as never,
    }).checksum;
    const built = build([
      pluginWith('h', { beforeEvaluate: (input, rules) => ({ input, rules: [...rules, add] }) }),
      slowHook,
    ]);
    setTimeout(() => ((add.params as { rate: number }).rate = 7000), 5);
    const result = await built.engine.evaluate([makeRule({ id: 'slow', model: 'm' })], makeInput());
    expect(result.appliedRules.find((r) => r.id === 'add')?.params).toEqual({ rate: 7 });
  });

  it('A6: class-instance dimensions are refused, not kept', () => {
    class Dim {
      region = 'TG';
    }
    const result = prepare({
      requestId: 'r',
      data: {},
      meta: { tenantId: 't', dimensions: new Dim() },
    });
    expect(result).toBeInstanceOf(ValidationError);
  });

  it('class-instance dates are refused too', () => {
    class Dates {
      facture = '2025-01-01';
    }
    expect(
      prepare({ requestId: 'r', data: {}, meta: { tenantId: 't', dates: new Dates() } }),
    ).toBeInstanceOf(ValidationError);
  });

  it('C1: a Proxy rule whose prototype changes between reads fails as a PluginHookError', async () => {
    class Fake {}
    let reads = 0;
    const real = makeRule({ id: 'add', model: 'flat', params: { rate: 7 } });
    const proxy = new Proxy(real, {
      getPrototypeOf: () => (++reads === 1 ? Fake.prototype : Object.prototype),
    });
    const built = build([
      pluginWith('h', { beforeEvaluate: (input, rules) => ({ input, rules: [...rules, proxy] }) }),
    ]);
    const error = await failure(built, [tax()]);
    expect(error).toBeInstanceOf(PluginHookError);
  });

  it('a Box inside a refused source rule is not kept by reference', async () => {
    class Box {
      v = 1;
    }
    const box = new Box();
    const built = build([]);
    const result = await built.engine.evaluate(
      [{ ...tax(), params: { rate: 1, box } } as Rule],
      makeInput(),
    );
    const kept = (result.skippedRules[0]!.rule.params as { box?: unknown }).box;
    expect(kept).not.toBe(box);
    expect(Object.isFrozen(box)).toBe(false);
  });
});

describe('S2: a skip is read once into a plain record', () => {
  it('B1: a class-instance skip with an accessor reason is refused', async () => {
    let reads = 0;
    class Skip {
      rule: Rule;
      constructor(rule: Rule) {
        this.rule = rule;
      }
      get reason(): string {
        return ++reads <= 2 ? 'PLUGIN' : 'CHECKSUM_MISMATCH';
      }
    }
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [],
          skipped: [new Skip(rules[0]!)] as never,
        }),
      }),
    ]);
    const error = await failure(built, [tax()]);
    expect(error).toBeInstanceOf(PluginHookError);
  });

  it('a plain skip with an accessor reason is invoked once', async () => {
    let reads = 0;
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          const skip = { rule: rules[0]! } as Record<string, unknown>;
          Object.defineProperty(skip, 'reason', {
            enumerable: true,
            get: () => (++reads <= 1 ? 'PLUGIN' : 'CHECKSUM_MISMATCH'),
          });
          return { input, rules: [], skipped: [skip] as never };
        },
      }),
    ]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.skippedRules[0]!.reason).toBe('PLUGIN');
    expect(reads).toBe(1);
  });
});

describe('S3: the total a hook can make the engine read is bounded', () => {
  it('D1: the same big rule returned many times is refused within the aggregate bound, quickly', async () => {
    const big = makeRule({
      id: 'big',
      model: 'm',
      params: { pad: new Array<number>(50_000).fill(1) },
    });
    const built = build(
      [
        pluginWith('h', {
          beforeEvaluate: (input, rules) => ({
            input,
            rules: [...rules, ...new Array<Rule>(50).fill(big)],
          }),
        }),
      ],
      { limits: { maxHookLeaves: 200_000 } },
    );
    const started = Date.now();
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).toMatchObject({
      message: expect.stringContaining('engine limit maxHookLeaves exceeded'),
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('D3: source rules sharing one big params are held to maxRuleSetNodes', async () => {
    const pad = new Array<number>(50_000).fill(1);
    const rules = Array.from({ length: 20 }, (_, i) =>
      makeRule({ id: `r${i}`, model: 'm', params: { pad } }),
    );
    const built = build([], { limits: { maxRuleSetNodes: 200_000 } });
    const started = Date.now();
    const error = await failure(built, rules);
    expect(error).toMatchObject({ limit: 'maxRuleSetNodes', max: 200_000 });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('D2: an afterEvaluate return with many extra fields is refused at the first, before any is read', async () => {
    const big = new Array<number>(400_000).fill(1);
    const built = build([
      pluginWith('h', {
        afterEvaluate: (_input, result) => {
          const extra: Record<string, unknown> = {};
          for (let i = 0; i < 50; i += 1) extra[`f${i}`] = big;
          return { ...result, ...extra } as never;
        },
      }),
    ]);
    const started = Date.now();
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error.cause as Error).message).toMatch(/a field other than annotations: requestId/);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('S4: the engine holds no Date', () => {
  const dated = (): Rule =>
    makeRule({
      id: 'd',
      model: 'flat',
      params: { rate: 3, since: new Date('2024-01-01T00:00:00Z') },
      condition: { dsl: 'slow', value: { at: new Date('2024-01-01T00:00:00Z') } },
    });

  it('E2: validateParams receives the date as a string, and cannot move it', async () => {
    let seen: unknown;
    const spy: CalculationModel = {
      name: 'spy',
      version: '1.0.0',
      validateParams: (params) => {
        seen = (params as { since: unknown }).since;
        return { valid: true };
      },
      calculate: () => 1,
    };
    const built = build([pluginWith('reg', { onInit: (c) => c.modelRegistry.register(spy) })]);
    await built.engine.evaluate(
      [makeRule({ id: 's', model: 'spy', params: { since: new Date('2024-01-01T00:00:00Z') } })],
      makeInput(),
    );
    expect(seen).toBe('2024-01-01T00:00:00.000Z');
  });

  it('E3: the DSL receives condition.value dates as strings', async () => {
    let seen: unknown;
    const spy: DSLEvaluator = {
      dsl: 'slow',
      version: '1.0.0',
      evaluate: (expression) => {
        seen = (expression as { at: unknown }).at;
        return true;
      },
    };
    const built = build([], {}, [spy]);
    await built.engine.evaluate([dated()], makeInput());
    expect(seen).toBe('2024-01-01T00:00:00.000Z');
  });

  it('the result and the record hold strings, never Dates, in rules', async () => {
    const built = build([]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(typeof result.appliedRules[0]!.effectiveFrom).toBe('string');
    expect(typeof built.saved[0]!.rulesSnapshot[0]!.effectiveFrom).toBe('string');
  });
});

describe('S5: writes are trapped and classified by class, never by message', () => {
  const regModel = (model: CalculationModel): PPEPlugin =>
    pluginWith('reg', { onInit: (c) => c.modelRegistry.register(model) });

  it("E1: a write in validateParams is that rule's MODEL_ERROR", async () => {
    const writer: CalculationModel = {
      name: 'vw',
      version: '1.0.0',
      validateParams: (params) => {
        (params as Record<string, unknown>)['rate'] = 1;
        return { valid: true };
      },
      calculate: () => 1,
    };
    const built = build([regModel(writer)]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'w', model: 'vw', params: { rate: 5 } }), makeRule({ id: 'ok', model: 'm' })],
      makeInput(),
    );
    expect(result.appliedRules.map((r) => r.id)).toEqual(['ok']);
    expect(result.skippedRules.find((s) => s.rule.id === 'w')?.reason).toBe('MODEL_ERROR');
  });

  it("E4: a TypeError of the model's own, with a write-like message, fails the evaluation", async () => {
    const thrower: CalculationModel = {
      name: 'th',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => {
        throw new TypeError('Cannot assign a tax bracket: table missing');
      },
    };
    const built = build([regModel(thrower)]);
    const error = await failure(built, [makeRule({ id: 't', model: 'th' })]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as { cause: unknown }).cause).toMatchObject({ name: 'TypeError' });
  });

  it("E5: a write into the model's own frozen table fails the evaluation", async () => {
    const table = Object.freeze({ a: 1 });
    const own: CalculationModel = {
      name: 'own',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => {
        (table as Record<string, number>)['a'] = 2;
        return 1;
      },
    };
    const built = build([regModel(own)]);
    const error = await failure(built, [makeRule({ id: 'o', model: 'own' })]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as { cause: unknown }).cause).toMatchObject({ name: 'TypeError' });
  });

  it("a DSL writing into its expression is that rule's DSL_ERROR", async () => {
    const writer: DSLEvaluator = {
      dsl: 'slow',
      version: '1.0.0',
      evaluate: (expression) => {
        (expression as Record<string, unknown>)['x'] = 1;
        return true;
      },
    };
    const built = build([], {}, [writer]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'd', model: 'm', condition: { dsl: 'slow', value: { y: 1 } } })],
      makeInput(),
    );
    expect(result.skippedRules[0]!.reason).toBe('DSL_ERROR');
  });
});

describe('S6: roots that cannot be read are named', () => {
  const revoked = (): object => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  };
  it('G1, G2: data and meta given as a revoked Proxy', () => {
    for (const input of [
      { requestId: 'r', data: revoked(), meta: { tenantId: 't' } },
      { requestId: 'r', data: {}, meta: revoked() },
    ]) {
      expect(prepare(input)).toBeInstanceOf(ValidationError);
    }
  });
  it('G3, G4: rules given as null or a revoked Proxy', async () => {
    const built = build([]);
    expect(await failure(built, null)).toBeInstanceOf(ValidationError);
    expect(await failure(built, revoked())).toBeInstanceOf(ValidationError);
  });
});

describe('S7: the registries are fixed for the evaluation', () => {
  it('J1: a model registered during the evaluation is not seen, so a rule added with it is refused', async () => {
    let context!: PluginContext;
    const late: CalculationModel = {
      name: 'late',
      version: '1.0.0',
      validateParams: () => ({ valid: false, errors: ['no'] }),
      calculate: () => 101,
    };
    const built = build([
      pluginWith('grab', { onInit: (c) => void (context = c) }),
      pluginWith('b', {
        beforeEvaluate: (input, rules) => {
          context.modelRegistry.register(late);
          return { input, rules };
        },
      }),
      pluginWith('a', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [...rules, makeRule({ id: 'late', model: 'late', params: { rate: 'junk' } })],
        }),
      }),
    ]);
    const error = await failure(built, [tax()]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: 'a' });
    expect(((error as PluginHookError).cause as Error).message).toBe(
      'plugin a added rule late@1, whose model late is not registered',
    );
  });

  it('J1: a DSL registered during the evaluation is not seen', async () => {
    let context!: PluginContext;
    const built = build([
      pluginWith('grab', { onInit: (c) => void (context = c) }),
      pluginWith('b', {
        beforeEvaluate: (input, rules) => {
          context.dslRegistry.register({ dsl: 'late', version: '1.0.0', evaluate: () => true });
          return { input, rules };
        },
      }),
    ]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'd', model: 'm', condition: { dsl: 'late', value: null } })],
      makeInput(),
    );
    expect(result.skippedRules[0]).toMatchObject({ reason: 'DSL_NOT_FOUND' });
  });

  it('J2: a hook replacing a model through getAll() changes nothing', async () => {
    let context!: PluginContext;
    const built = build([
      pluginWith('grab', { onInit: (c) => void (context = c) }),
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          try {
            (context.modelRegistry.getAll() as unknown as Map<string, CalculationModel>).set(
              'FLAT',
              {
                ...FLAT,
                calculate: () => 123456,
              },
            );
          } catch {
            // a frozen view refuses the write
          }
          return { input, rules };
        },
      }),
    ]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.value).toBe(100);
  });
});

describe('S8: the error a plugin sees is not the error the caller gets', () => {
  it('O1: onError cannot rewrite the attribution of the failure', async () => {
    const failing = pluginWith('failing', {
      beforeEvaluate: () => {
        throw new Error('boom');
      },
    });
    const meddler = pluginWith('meddler', {
      onError: (error) => {
        try {
          (error as unknown as Record<string, unknown>)['message'] = 'all fine';
          (error as unknown as Record<string, unknown>)['plugin'] = 'host';
        } catch {
          // frozen
        }
      },
    });
    const built = build([failing, meddler]);
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect(error.plugin).toBe('failing');
    expect(error.message).toBe('plugin failing beforeEvaluate failed: boom');
  });
});

describe('S10: a plugin skip always names the plugin', () => {
  it('the detail is prefixed by the engine', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [],
          skipped: [{ rule: rules[0]!, reason: 'PLUGIN' as never, detail: 'my words' }],
        }),
      }),
    ]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.skippedRules[0]!.detail).toBe('plugin h: my words');
  });
});

describe('S11: the views refuse writes', () => {
  it('F1, F2: meta.dates of the view is frozen, and the result handed to afterEvaluate refuses writes', async () => {
    const seen: Record<string, unknown> = {};
    const built = build([
      pluginWith('h', {
        afterEvaluate: (input, result) => {
          seen['dates'] = Object.isFrozen(input.meta.dates);
          for (const [name, write] of [
            ['result', () => ((result as unknown as Record<string, unknown>)['value'] = 1)],
            ['applied', () => (result.appliedRules as unknown as unknown[]).push(1)],
            [
              'deep',
              () => ((result.appliedRules[0]!.params as Record<string, unknown>)['rate'] = 0),
            ],
          ] as const) {
            try {
              write();
              seen[name] = 'written';
            } catch (error) {
              seen[name] = (error as Error).name;
            }
          }
          seen['timestamp'] = result.timestamp.toISOString().length;
          return undefined;
        },
      }),
    ]);
    await built.engine.evaluate(
      [tax()],
      makeInput({ meta: { tenantId: 't', dates: { facture: new Date('2025-01-01T00:00:00Z') } } }),
    );
    expect(seen).toEqual({
      dates: true,
      result: 'FrozenViewWriteError',
      applied: 'FrozenViewWriteError',
      deep: 'FrozenViewWriteError',
      timestamp: 24,
    });
  });
});

describe('S16: beforeEvaluate may not change meta', () => {
  const change = (patch: (meta: Record<string, unknown>) => Record<string, unknown>): PPEPlugin =>
    pluginWith('h', {
      beforeEvaluate: (input, rules) => ({
        input: { ...input, meta: patch({ ...input.meta }) as never },
        rules,
      }),
    });
  it('P13: the evaluation date', async () => {
    const built = build([change((meta) => ({ ...meta, effectiveDate: new Date('1970-01-01') }))]);
    const error = await failure(
      built,
      [tax()],
      makeInput({ meta: { tenantId: 't', effectiveDate: new Date('2025-01-01') } }),
    );
    expect(error).toBeInstanceOf(PluginHookError);
    expect(((error as PluginHookError).cause as Error).message).toBe(
      'plugin h changed meta, which only the caller declares',
    );
  });
  it('the tags', async () => {
    const built = build([change((meta) => ({ ...meta, tags: ['x'] }))]);
    expect(await failure(built, [tax()])).toBeInstanceOf(PluginHookError);
  });
  it('the dimensions', async () => {
    const built = build([change((meta) => ({ ...meta, dimensions: { country: 'XX' } }))]);
    expect(await failure(built, [tax()])).toBeInstanceOf(PluginHookError);
  });
  it('a change to data stays allowed', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input: { ...input, data: { ...input.data, x: 1 } },
          rules,
        }),
      }),
    ]);
    expect(await failure(built, [tax()])).toBeUndefined();
  });
});

describe('S12: the survivors of the fourth review', () => {
  const hook = (returned: (rules: readonly Rule[]) => Record<string, unknown>): PPEPlugin =>
    pluginWith('h', {
      beforeEvaluate: (input, rules) => ({ input, ...returned(rules) }) as never,
    });

  it("M21: what the reader cannot copy inside a hook's state is refused, named", async () => {
    const built = build([hook((rules) => ({ rules, state: { [Symbol('s')]: 1 } }))]);
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect((error.cause as Error).message).toMatch(/has a symbol key/);
  });

  it('M21: a hole in the state is refused, named', async () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    const built = build([hook((rules) => ({ rules, state: sparse }))]);
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect((error.cause as Error).message).toMatch(/has a hole at index 1/);
  });

  it('M24: the detail of a skip is a string', async () => {
    const built = build([
      hook((rules) => ({ rules: [], skipped: [{ rule: rules[0]!, reason: 'PLUGIN', detail: 5 }] })),
    ]);
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect((error.cause as Error).message).toBe(
      'plugin h beforeEvaluate returned a malformed skipped',
    );
  });

  it('M60: the skips are bounded by maxRules, and read as a list', async () => {
    const built = build(
      [
        hook((rules) => ({
          rules: [],
          skipped: [1, 2, 3, 4].map(() => ({ rule: rules[0]!, reason: 'PLUGIN' })),
        })),
      ],
      { limits: { maxRules: 3 } },
    );
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect(error.cause).toMatchObject({
      message: expect.stringContaining('engine limit maxRules exceeded: 4 > 3'),
    });
  });

  it('M58: the depth of the annotations an afterEvaluate returns is bounded', async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i += 1) deep = { a: deep };
    const built = build([
      pluginWith('h', {
        afterEvaluate: () => ({ annotations: { deep } }) as never,
      }),
    ]);
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect(error.cause).toMatchObject({ name: 'EngineLimitError' });
    expect(error.cause).toMatchObject({
      message: expect.stringContaining('engine limit maxInputDepth exceeded'),
    });
  });

  it('M51: a label a plugin added and another skipped cannot be added again with other content', async () => {
    const extra = makeRule({ id: 'x', model: 'flat', params: { rate: 1 } });
    const built = build([
      pluginWith('a', { beforeEvaluate: (input, rules) => ({ input, rules: [...rules, extra] }) }),
      pluginWith('b', {
        beforeEvaluate: (input, rules) =>
          ({
            input,
            rules: rules.filter((r) => r.id !== 'x'),
            skipped: rules.filter((r) => r.id === 'x').map((rule) => ({ rule, reason: 'PLUGIN' })),
          }) as never,
      }),
      pluginWith('c', {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [...rules, makeRule({ id: 'x', model: 'flat', params: { rate: 9 } })],
        }),
      }),
    ]);
    const error = await failure(built, [tax()]);
    expect(error).toMatchObject({ plugin: 'c' });
  });

  it("the record of a skip holds the engine's own rule, not the hook's copy", async () => {
    let mine: Rule | undefined;
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          mine = { ...rules[0]! } as Rule;
          return { input, rules: [], skipped: [{ rule: mine, reason: 'PLUGIN' as never }] };
        },
      }),
    ]);
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.skippedRules[0]!.rule).not.toBe(mine);
  });
});

describe('the rest of the survivors of the fourth review', () => {
  it('the leaves of the input a hook returns count against the same bound', async () => {
    const built = build(
      [
        pluginWith('h', {
          beforeEvaluate: (input, rules) => ({
            input: {
              ...input,
              data: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])),
            },
            rules,
          }),
        }),
      ],
      { limits: { maxHookLeaves: 100 } },
    );
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect(error.cause).toMatchObject({
      message: expect.stringContaining('engine limit maxHookLeaves exceeded'),
    });
  });

  it('a class-instance skip is refused even when its keys are own accessors read once', async () => {
    class Skip {}
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => {
          const skip = new Skip();
          Object.defineProperty(skip, 'rule', { enumerable: true, value: rules[0] });
          Object.defineProperty(skip, 'reason', { enumerable: true, get: () => 'PLUGIN' });
          return { input, rules: [], skipped: [skip] as never };
        },
      }),
    ]);
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect((error.cause as Error).message).toBe(
      'plugin h beforeEvaluate returned a malformed skipped',
    );
  });

  const regModel = (model: CalculationModel): PPEPlugin =>
    pluginWith('reg', { onInit: (c) => c.modelRegistry.register(model) });
  const writing = (
    name: string,
    write: (target: Record<string, unknown>) => void,
  ): CalculationModel => ({
    name,
    version: '1.0.0',
    validateParams: () => ({ valid: true }),
    calculate: (_input, rule) => {
      write(rule as unknown as Record<string, unknown>);
      return 1;
    },
  });

  it('a delete and a defineProperty on a view are refused like an assignment', async () => {
    const built = build([
      pluginWith('reg1', {
        onInit: (c) =>
          c.modelRegistry.register(writing('del', (rule) => void delete rule['priority'])),
      }),
      pluginWith('reg2', {
        onInit: (c) =>
          c.modelRegistry.register(
            writing('def', (rule) => void Object.defineProperty(rule, 'x', { value: 1 })),
          ),
      }),
    ]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'del', model: 'del' }), makeRule({ id: 'def', model: 'def' })],
      makeInput(),
    );
    expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
      ['def', 'MODEL_ERROR', 'wrote to its input: x'],
      ['del', 'MODEL_ERROR', 'wrote to its input: priority'],
    ]);
  });

  it('listVariables writing into its argument is a problem, named, and writes nothing', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'slow',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: (expression) => {
        (expression as Record<string, unknown>)['x'] = 1;
        return [];
      },
    };
    const built = build([], {}, [dsl]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'd', model: 'm', condition: { dsl: 'slow', value: { y: 1 } } })],
      makeInput(),
    );
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'listVariables of slow for d@1 failed: wrote to its input: x',
    ]);
    expect(built.saved[0]!.rulesSnapshot[0]!.condition).toEqual({ dsl: 'slow', value: { y: 1 } });
  });

  it('what a model returns is copied: an output that is a view of its input is plain data', async () => {
    const OBJ = { type: 'object', combine: 'highestPriority' } as const;
    const returning: CalculationModel = {
      name: 'obj',
      version: '1.0.0',
      output: OBJ,
      validateParams: () => ({ valid: true }),
      calculate: (input) => input['nest'] as never,
    };
    const built = build([regModel(returning)]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'o', model: 'obj', output: 'thing' })],
      makeInput({ data: { nest: { v: 1 } } }),
    );
    const value = result.outputs['thing']!.value as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value).toEqual({ v: 1 });
    expect(built.saved).toHaveLength(1);
  });
});

describe('the view handed to afterEvaluate is stable', () => {
  it('reading the same member twice gives the same object; a Date is a fresh copy at each read', async () => {
    const seen: boolean[] = [];
    const built = build([
      pluginWith('h', {
        afterEvaluate: (_input, result) => {
          seen.push(result.appliedRules === result.appliedRules);
          seen.push(result.appliedRules[0] === result.appliedRules[0]);
          seen.push(result.timestamp !== result.timestamp);
          return undefined;
        },
      }),
    ]);
    await built.engine.evaluate([tax()], makeInput());
    expect(seen).toEqual([true, true, true]);
  });
});
