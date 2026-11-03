import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { describe, it, expect } from 'vitest';
import { EXCEPTION_MODEL } from '@run-iq/spec';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { FrozenViewWriteError } from '../../src/errors/FrozenViewWriteError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { resolveLimits } from '../../src/limits.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { ISnapshotAdapter, Snapshot } from '../../src/types/snapshot.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Round 5 of the 9L audit (T1 to T15 and the survivors of round 4).

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
interface Built {
  readonly engine: PPEEngine;
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
  return { engine, saved };
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
const regModel = (name: string, model: CalculationModel): PPEPlugin =>
  pluginWith(name, { onInit: (c) => c.modelRegistry.register(model) });

describe('T1: what a plugin receives as an error is a deep copy', () => {
  it('S8: onError cannot rewrite the cause the caller receives', async () => {
    const failing = pluginWith('failing', {
      beforeEvaluate: () => {
        throw new Error('boom');
      },
    });
    const meddler = pluginWith('meddler', {
      onError: (error) => {
        try {
          (error.cause as { message: string }).message = 'all fine';
        } catch {
          // frozen
        }
      },
    });
    const error = (await failure(build([failing, meddler]), [tax()])) as PluginHookError;
    expect((error.cause as Error).message).toBe('boom');
  });

  it('S8b: onError cannot rewrite the fields of an EngineLimitError cause', async () => {
    const meddler = pluginWith('meddler', {
      onError: (error) => {
        const cause = error.cause as { limit: string; max: number } | undefined;
        try {
          if (cause !== undefined) {
            cause.limit = 'maxRules';
            cause.max = 999;
          }
        } catch {
          // frozen
        }
      },
    });
    const adder = pluginWith('adder', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [...rules, ...[1, 2, 3].map((i) => makeRule({ id: `x${i}`, model: 'm' }))],
      }),
    });
    const error = (await failure(build([adder, meddler], { limits: { maxRules: 3 } }), [
      tax(),
    ])) as PluginHookError;
    expect(error.cause).toMatchObject({ limit: 'maxRules', max: 3, actual: 4 });
  });
});

describe('T3: ownership belongs to one evaluation', () => {
  it('S3x: a rule handed out by one engine is untrusted data to another', async () => {
    let captured: Rule | undefined;
    const a = build(
      [
        pluginWith('grab', {
          beforeEvaluate: (input, rules) => ((captured = rules[0]), { input, rules }),
        }),
      ],
      { limits: { maxRuleLeaves: 1_000_000 } },
    );
    await a.engine.evaluate(
      [
        makeRule({
          id: 'big',
          model: 'flat',
          params: { rate: 1, pad: new Array<number>(5000).fill(1) },
        }),
      ],
      makeInput(),
    );
    const b = build([], { limits: { maxRuleLeaves: 100 } });
    const error = await failure(b, [captured]);
    expect(error).toMatchObject({ limit: 'maxRuleLeaves', max: 100 });
  });

  it('S3y: results of one engine given as source rules to another are bounded by the other', async () => {
    const a = build([], { limits: { maxRuleLeaves: 1_000_000 } });
    const result = await a.engine.evaluate(
      [
        makeRule({
          id: 'big',
          model: 'flat',
          params: { rate: 1, pad: new Array<number>(5000).fill(1) },
        }),
      ],
      makeInput({ requestId: 'a' }),
    );
    const b = build([], { limits: { maxRuleLeaves: 100 } });
    expect(await failure(b, result.appliedRules)).toMatchObject({ limit: 'maxRuleLeaves' });
  });
});

describe('T4: the models an evaluation runs are fixed with their functions', () => {
  it("S7a: replacing a registered model's method during an evaluation changes nothing", async () => {
    const own: CalculationModel = {
      name: 'own',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => 1,
    };
    const built = build([
      regModel('a', own),
      pluginWith('b', {
        beforeEvaluate: (input, rules) => {
          (own as unknown as { calculate: () => number }).calculate = () => 424242;
          return { input, rules };
        },
      }),
    ]);
    const result = await built.engine.evaluate([makeRule({ id: 'o', model: 'own' })], makeInput());
    expect(result.value).toBe(1);
  });

  it('AD5: the registries tell a plugin descriptors: frozen data, no object and no function', () => {
    let context!: PluginContext;
    const own: CalculationModel = {
      name: 'own',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => 1,
    };
    build([pluginWith('grab', { onInit: (c) => void (context = c) }), regModel('a', own)]);
    const one = context.modelRegistry.get('own');
    expect(one).toEqual({ name: 'own', version: '1.0.0' });
    expect(Object.isFrozen(one)).toBe(true);
    const all = context.modelRegistry.getAll();
    expect(Object.isFrozen(all)).toBe(true);
    expect(all.map((m) => m.name)).toContain('own');
    for (const model of all) {
      expect(Object.isFrozen(model)).toBe(true);
      for (const value of Object.values(model)) expect(typeof value).not.toBe('function');
    }
    expect(() => (all as unknown as unknown[]).push({})).toThrow(TypeError);
    expect(context.modelRegistry.has('x')).toBe(false);
  });
});

describe('T5, T6, T7: the views', () => {
  it('S5x: a validateParams write in the exception-substitution path excludes the target', async () => {
    const vp: CalculationModel = {
      name: 'vp',
      version: '1.0.0',
      validateParams: (params) => {
        // Valid as given; it writes only once an exception has substituted `y: 1`.
        if ((params as { y?: number }).y === 1) (params as Record<string, unknown>)['x'] = 1;
        return { valid: true };
      },
      calculate: () => 1,
    };
    const built = build([regModel('reg', vp)]);
    const substitute = makeRule({
      id: 'sub',
      model: EXCEPTION_MODEL,
      priority: 9000,
      exceptions: [{ kind: 'substitute', targets: { ids: ['vp'] }, params: { y: 1 } }],
    } as never);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'vp', model: 'vp', params: { y: 0 } }), substitute],
      makeInput(),
    );
    expect(result.skippedRules.find((s) => s.rule.id === 'vp')?.reason).toBe('MODEL_ERROR');
  });

  it('T6: Object.freeze and preventExtensions on a view are not writes', async () => {
    const freezer: CalculationModel = {
      name: 'frz',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (_input, _rule, params) => {
        Object.freeze(params);
        Object.preventExtensions(params as object);
        return (params as { rate: number }).rate;
      },
    };
    const built = build([regModel('reg', freezer)]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'f', model: 'frz', params: { rate: 4 } })],
      makeInput(),
    );
    expect(result.value).toBe(4);
  });

  it('N18: setPrototypeOf on a view is a write', async () => {
    const proto: CalculationModel = {
      name: 'pro',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (_input, _rule, params) => {
        Object.setPrototypeOf(params, null);
        return 1;
      },
    };
    const built = build([regModel('reg', proto)]);
    const result = await built.engine.evaluate([makeRule({ id: 'p', model: 'pro' })], makeInput());
    expect(result.skippedRules[0]).toMatchObject({ reason: 'MODEL_ERROR' });
  });

  it('T7: a model throwing a forged FrozenViewWriteError fails the evaluation', async () => {
    const forger: CalculationModel = {
      name: 'for',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => {
        throw new FrozenViewWriteError('fake');
      },
    };
    const built = build([regModel('reg', forger)]);
    const error = await failure(built, [makeRule({ id: 'f', model: 'for' })]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as { cause: unknown }).cause).toMatchObject({ name: 'FrozenViewWriteError' });
  });
});

describe('T8: a Date a view shows is not shared between readers', () => {
  it('N20: one plugin moving result.timestamp does not move what the next one reads', async () => {
    const seen: string[] = [];
    const built = build([
      pluginWith('a', { afterEvaluate: (_i, r) => void (r.timestamp as Date).setTime(0) }),
      pluginWith('b', { afterEvaluate: (_i, r) => void seen.push(r.timestamp.toISOString()) }),
    ]);
    await built.engine.evaluate([tax()], makeInput());
    expect(seen[0]).not.toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('T9: what is not plain is refused where it is read, with its pointer', () => {
  it('S1p: a class-instance source rule is a ValidationError naming its index', async () => {
    class RuleCls {
      id = 'x';
    }
    const error = await failure(build([]), [tax(), new RuleCls()]);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).reasons).toEqual(['rules/1 is not a plain object: RuleCls']);
  });

  it('S1o: a Box inside a source rule skips that rule, naming the pointer; the record holds no marker', async () => {
    class Box {
      v = 1;
    }
    const built = build([]);
    const result = await built.engine.evaluate(
      [{ ...tax(), params: { rate: 1, b: new Box() } } as Rule],
      makeInput(),
    );
    const skip = result.skippedRules[0]!;
    expect(skip.reason).toBe('INVALID_RULE');
    expect(skip.detail).toBe('Invalid rule tax@1: /params/b is not a plain object: Box');
    expect(JSON.stringify(built.saved[0]!.rulesSnapshot)).not.toContain('description');
    expect(typeof (skip.rule.params as { b: unknown }).b).toBe('string');
  });

  it('S1q: a class-instance rule a hook adds fails naming its index', async () => {
    class RuleCls {}
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({ input, rules: [...rules, new RuleCls() as never] }),
      }),
    ]);
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect((error.cause as Error).message).toMatch(/rules\/1 is not a plain object: RuleCls/);
  });
});

describe('T11: hostile options are named', () => {
  it('a revoked Proxy, and a Proxy whose ownKeys throws', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('x');
        },
      },
    );
    for (const options of [proxy, hostile]) {
      const error = await build([])
        .engine.evaluate([tax()], makeInput(), options as never)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ValidationError);
    }
  });
});

describe('T14: a model output that cannot be copied excludes that rule', () => {
  it('S1t: a cyclic output', async () => {
    const OBJ = { type: 'object', combine: 'highestPriority' } as const;
    const cyclic: CalculationModel = {
      name: 'cyc',
      version: '1.0.0',
      output: OBJ,
      validateParams: () => ({ valid: true }),
      calculate: () => {
        const a: Record<string, unknown> = {};
        a['self'] = a;
        return a as never;
      },
    };
    const built = build([regModel('reg', cyclic)]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'c', model: 'cyc', output: 'thing' })],
      makeInput(),
    );
    expect(result.skippedRules[0]).toMatchObject({ reason: 'OUTPUT_MISMATCH' });
  });
});

describe('T15: meta is compared on its exact shape; dimensions {} is refused at entry', () => {
  const prepare = (meta: Record<string, unknown>): unknown => {
    try {
      return InputSanitizer.prepare(
        { requestId: 'r', data: {}, meta: { tenantId: 't', ...meta } },
        resolveLimits(),
      );
    } catch (error) {
      return error;
    }
  };
  it('an empty dimensions is refused: omit it to declare none', () => {
    expect(prepare({ dimensions: {} })).toMatchObject({
      reasons: ['/meta/dimensions is empty: omit it to declare no dimensions'],
    });
  });
  it('S16a: a hook adding an empty dimensions fails', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input: { ...input, meta: { ...input.meta, dimensions: {} } },
          rules,
        }),
      }),
    ]);
    expect(await failure(built, [tax()])).toBeInstanceOf(PluginHookError);
  });
});

describe('S12 survivors of round 5', () => {
  it("N47: a hook's state counts against maxHookLeaves", async () => {
    const built = build(
      [
        pluginWith('h', {
          beforeEvaluate: (input, rules) => ({
            input,
            rules,
            state: new Array(200).fill(1) as never,
          }),
        }),
      ],
      { limits: { maxHookLeaves: 100 } },
    );
    expect(((await failure(built, [tax()])) as PluginHookError).cause).toMatchObject({
      limit: 'maxHookLeaves',
    });
  });
  it("N48: a skip's rule, when it is a copy, counts against maxHookLeaves", async () => {
    const built = build(
      [
        pluginWith('h', {
          beforeEvaluate: (input, rules) => ({
            input,
            rules: [],
            skipped: [{ rule: { ...rules[0]! } as Rule, reason: 'PLUGIN' as never }],
          }),
        }),
      ],
      { limits: { maxHookLeaves: 5 } },
    );
    expect(((await failure(built, [tax()])) as PluginHookError).cause).toMatchObject({
      limit: 'maxHookLeaves',
    });
  });
});

describe('more survivors of round 5', () => {
  it('N-budget: two hooks each under maxHookLeaves, together over it, are refused', async () => {
    const stateOf = (n: number) => new Array(n).fill(1) as never;
    const built = build(
      [
        pluginWith('a', {
          beforeEvaluate: (input, rules) => ({ input, rules, state: stateOf(60) }),
        }),
        pluginWith('b', {
          beforeEvaluate: (input, rules) => ({ input, rules, state: stateOf(60) }),
        }),
      ],
      { limits: { maxHookLeaves: 100 } },
    );
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect(error).toMatchObject({ plugin: 'b' });
    expect(error.cause).toMatchObject({ limit: 'maxHookLeaves', max: 100 });
  });

  it("S7a for a DSL: replacing an evaluator's method during an evaluation changes nothing", async () => {
    const dsl: DSLEvaluator = { dsl: 'slow', version: '1.0.0', evaluate: () => true };
    const built = build(
      [
        pluginWith('b', {
          beforeEvaluate: (input, rules) => {
            (dsl as unknown as { evaluate: () => boolean }).evaluate = () => false;
            return { input, rules };
          },
        }),
      ],
      {},
      [dsl],
    );
    const result = await built.engine.evaluate(
      [makeRule({ id: 'd', model: 'm', condition: { dsl: 'slow', value: null } })],
      makeInput(),
    );
    expect(result.appliedRules.map((r) => r.id)).toEqual(['d']);
  });

  it('S16: a hook adding an empty tags (same canonical form, other shape) fails', async () => {
    const built = build([
      pluginWith('h', {
        beforeEvaluate: (input, rules) => ({
          input: { ...input, meta: { ...input.meta, tags: [] } },
          rules,
        }),
      }),
    ]);
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect((error.cause as Error).message).toBe(
      'plugin h changed meta, which only the caller declares',
    );
  });
});
