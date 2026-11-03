import { describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { FrozenViewWriteError } from '../../src/errors/FrozenViewWriteError.js';
import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { SnapshotSerializer } from '../../src/snapshot/SnapshotSerializer.js';
import { DSLRegistry, snapshotDsls } from '../../src/registry/DSLRegistry.js';
import { ModelRegistry, snapshotModels } from '../../src/registry/ModelRegistry.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { ISnapshotAdapter, Snapshot } from '../../src/types/snapshot.js';
import {
  makeRule,
  makeInput,
  StubModel,
  ValueModel,
  InMemorySnapshotAdapter,
  expectCopyOf,
} from '../helpers.js';

// Round 6 of the 9L audit (V1 to V11 and the rulings on the threat model).

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
const tax = (rate = 100): Rule => makeRule({ id: 'tax', model: 'FLAT', params: { rate } });
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
const regModel = (name: string, model: unknown): PPEPlugin =>
  pluginWith(name, {
    onInit: (c) => c.modelRegistry.register(model as CalculationModel),
  });

describe('V1: the declarations a model gives are copied when it is registered', () => {
  const declaration = () => ({ type: 'number', combine: 'sum' }) as const;

  it('Vg2: a plugin writing into model.output during an evaluation changes nothing', async () => {
    let context!: PluginContext;
    const model = new ValueModel('SUMM', declaration(), { a: 3, b: 4 });
    const built = build([
      pluginWith('grab', { onInit: (c) => void (context = c) }),
      regModel('a', model),
      pluginWith('b', {
        beforeEvaluate: (input, rules) => {
          const live = context.modelRegistry.get('SUMM') as unknown as {
            output: { combine: string };
          };
          live.output.combine = 'max';
          return { input, rules };
        },
      }),
    ]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'a', model: 'SUMM' }), makeRule({ id: 'b', model: 'SUMM' })],
      makeInput(),
    );
    expect(result.value).toBe(7);
  });

  it('Vg2b: the same write made before the evaluation, after registration, changes nothing', async () => {
    const output = declaration() as { type: string; combine: string };
    const model = new ValueModel('SUMM', output as never, { a: 3, b: 4 });
    const built = build([regModel('a', model)]);
    output.combine = 'max';
    const result = await built.engine.evaluate(
      [makeRule({ id: 'a', model: 'SUMM' }), makeRule({ id: 'b', model: 'SUMM' })],
      makeInput(),
    );
    expect(result.value).toBe(7);
  });

  it('Vg3: the declaration is read once, and the copy is the one validated', () => {
    let reads = 0;
    const model: CalculationModel = {
      name: 'ONCE',
      version: '1.0.0',
      get output() {
        reads += 1;
        return reads === 1 ? declaration() : ({ type: 'bogus', combine: 'sum' } as never);
      },
      validateParams: () => ({ valid: true }),
      calculate: () => 1,
    };
    const registry = new ModelRegistry();
    registry.register(model);
    expect(reads).toBe(1);
    const fixed = snapshotModels(registry).get('ONCE');
    expect(reads).toBe(1);
    expect(fixed.output).toEqual(declaration());
    expect(Object.isFrozen(fixed.output)).toBe(true);
  });

  it('Vg4: a declaration that cannot be copied is refused at registration, by name', () => {
    const registry = new ModelRegistry();
    class Box {}
    const model = {
      name: 'BOX',
      version: '1.0.0',
      output: { type: 'number', combine: 'sum', extra: new Box() },
      validateParams: () => ({ valid: true }),
      calculate: () => 1,
    } as unknown as CalculationModel;
    expect(() => registry.register(model)).toThrow(/BOX/);
  });

  it("Vj3: an evaluator's capabilities are a frozen copy taken at registration", () => {
    const capabilities = { pure: true };
    const evaluator = {
      dsl: 'cap',
      version: '1.0.0',
      evaluate: () => true,
      capabilities,
    } as unknown as DSLEvaluator;
    const registry = new DSLRegistry();
    registry.register(evaluator);
    (capabilities as { pure: boolean }).pure = false;
    const fixed = snapshotDsls(registry).get('cap');
    expect((fixed as unknown as { capabilities: unknown }).capabilities).toEqual({ pure: true });
    expect(Object.isFrozen((fixed as unknown as { capabilities: unknown }).capabilities)).toBe(
      true,
    );
  });
});

describe('V2: undefined is not a JSON value', () => {
  it('Vs: dimensions with an undefined member are refused, with the pointer', async () => {
    const error = await failure(
      build([]),
      [tax()],
      makeInput({ meta: { tenantId: 't', dimensions: { region: undefined as never } } }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).reasons).toEqual([
      '/meta/dimensions/region is not JSON: undefined',
    ]);
  });

  it('Vs2: dates with an undefined member are refused, with the pointer', async () => {
    const error = await failure(
      build([]),
      [tax()],
      makeInput({ meta: { tenantId: 't', dates: { a: undefined as never } } }),
    );
    expect((error as ValidationError).reasons).toEqual(['/meta/dates/a is not JSON: undefined']);
  });

  it('Vt: no dimensions at all still applies a rule that declares some', async () => {
    const rule = makeRule({
      id: 'dim',
      model: 'FLAT',
      params: { rate: 7 },
      dimensions: { region: 'TG' },
    });
    const result = await build([]).engine.evaluate([rule], makeInput());
    expect(result.value).toBe(7);
    expect(result.skippedRules).toHaveLength(0);
  });

  it('Vu: an undefined member of a rule excludes that rule, with the pointer', async () => {
    const rule = { ...tax(), params: { rate: 5, note: undefined } } as unknown as Rule;
    const result = await build([]).engine.evaluate([rule], makeInput());
    expect(result.skippedRules[0]?.reason).toBe('INVALID_RULE');
    expect(result.skippedRules[0]?.detail).toContain('/params/note is not JSON: undefined');
  });
});

describe('V3: text is bounded and weighed', () => {
  it('La: a string longer than maxStringLength is refused with its pointer', async () => {
    const built = build([], { limits: { maxStringLength: 100 } });
    const error = await failure(built, [tax()], makeInput({ data: { text: 'x'.repeat(101) } }));
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({
      limit: 'maxStringLength',
      max: 100,
      actual: 101,
      pointer: '/data/text',
    });
    expect((error as Error).message).toBe(
      'engine limit maxStringLength exceeded: 101 > 100 at /data/text',
    );
  });

  it('La2: a key longer than maxStringLength is refused with its pointer', async () => {
    const built = build([], { limits: { maxStringLength: 100 } });
    const error = await failure(
      built,
      [tax()],
      makeInput({ data: { inner: { ['k'.repeat(101)]: 1 } } }),
    );
    expect(error).toMatchObject({ limit: 'maxStringLength', actual: 101 });
    expect((error as EngineLimitError).pointer).toBe(`/data/inner/${'k'.repeat(101)}`);
  });

  it('La3: the characters of a string count as nodes, one per 64', async () => {
    // key `a` is 1 node, the string is 1 + floor(640 / 64) = 11: 12 in all.
    const built = build([], { limits: { maxInputLeaves: 10, maxStringLength: 1000 } });
    const error = await failure(built, [tax()], makeInput({ data: { a: 'x'.repeat(640) } }));
    expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 10, actual: 12 });
    // 63 characters add nothing: 2 nodes.
    const small = build([], { limits: { maxInputLeaves: 10, maxStringLength: 1000 } });
    await expect(
      small.engine.evaluate([tax()], makeInput({ data: { a: 'x'.repeat(63) } })),
    ).resolves.toBeDefined();
  });

  it('La4: the characters of a key count as nodes too', async () => {
    // the key is 1 + floor(640 / 64) = 11 nodes, its scalar 1: 12 in all.
    const built = build([], { limits: { maxInputLeaves: 10, maxStringLength: 1000 } });
    const error = await failure(built, [tax()], makeInput({ data: { ['k'.repeat(640)]: 1 } }));
    expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 10, actual: 11 });
  });

  it('L1: a string shared by many rules costs what it weighs in each of them', async () => {
    const shared = 'x'.repeat(6400); // 100 nodes each time it is read
    const rules = Array.from({ length: 5 }, (_, index) =>
      makeRule({ id: `r${index}`, model: 'FLAT', params: { rate: 1, text: shared } }),
    );
    const built = build([], { limits: { maxRuleSetNodes: 300, maxStringLength: 10_000 } });
    const error = await failure(built, rules);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRuleSetNodes', max: 300 });
  });

  it('L1c: the same through a hook that adds the rules', async () => {
    const shared = 'x'.repeat(6400);
    const adder = pluginWith('adder', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [
          ...rules,
          ...Array.from({ length: 5 }, (_, index) =>
            makeRule({ id: `h${index}`, model: 'FLAT', params: { rate: 1, text: shared } }),
          ),
        ],
      }),
    });
    const built = build([adder], {
      limits: { maxHookLeaves: 300, maxStringLength: 10_000 },
    });
    const error = (await failure(built, [tax()])) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).toMatchObject({ limit: 'maxHookLeaves', max: 300 });
  });

  it('L7: the record is held to maxRecordLength, with a named error', async () => {
    const built = build([], { limits: { maxRecordLength: 1000 } });
    const error = await failure(built, [tax()], makeInput({ data: { text: 'x'.repeat(2000) } }));
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRecordLength', max: 1000 });
    expect((error as EngineLimitError).actual).toBeGreaterThan(2000);
    expect(built.saved).toHaveLength(0);
  });

  it('L7b: a runtime that cannot build the string is the same named limit', () => {
    // A string the runtime refuses to build: JSON.stringify throws a RangeError.
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    try {
      expect(() =>
        SnapshotSerializer.serialize(makeInput(), [], {} as never, {} as never, '1', {}, {}, 1000),
      ).toThrow(EngineLimitError);
    } finally {
      stringify.mockRestore();
    }
  });
});

describe('V4: the trace is bounded by the input times its steps', () => {
  it('Tn: nodes of the input times applied steps past maxTraceNodes is refused, by name', async () => {
    // data { a: 1, b: 2 } and the tenant: 4 + 2 = 6 nodes; 5 steps: 30.
    const rules = Array.from({ length: 5 }, (_, index) =>
      makeRule({ id: `r${index}`, model: 'FLAT', params: { rate: 1 } }),
    );
    const input = makeInput({ data: { a: 1, b: 2 } });
    const refused = await failure(build([], { limits: { maxTraceNodes: 29 } }), rules, input);
    expect(refused).toBeInstanceOf(EngineLimitError);
    expect(refused).toMatchObject({ limit: 'maxTraceNodes', max: 29, actual: 30 });
    const ok = build([], { limits: { maxTraceNodes: 30 } });
    await expect(ok.engine.evaluate(rules, input)).resolves.toBeDefined();
  });

  it('Tn2: every step shares the one frozen data of the evaluation', async () => {
    const rules = [
      makeRule({ id: 'a', model: 'FLAT', params: { rate: 1 } }),
      makeRule({ id: 'b', model: 'FLAT', params: { rate: 2 } }),
    ];
    const result = await build([]).engine.evaluate(rules, makeInput({ data: { x: 1 } }));
    const [first, second] = result.trace.steps;
    expect(first?.inputSnapshot).toBe(second?.inputSnapshot);
    expect(Object.isFrozen(first?.inputSnapshot)).toBe(true);
  });
});

describe('V5: a refused write is only the one a view of this call threw', () => {
  it('Vq: a view error caught in one evaluation and thrown in another fails the second', async () => {
    let caught: unknown;
    const writer: CalculationModel = {
      name: 'WRI',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (_input, _rule, params) => {
        try {
          (params as Record<string, number>)['rate'] = 2;
        } catch (error) {
          caught = error;
        }
        return 1;
      },
    };
    const replayer: CalculationModel = {
      name: 'REP',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => {
        throw caught;
      },
    };
    const built = build([regModel('w', writer), regModel('r', replayer)]);
    await built.engine.evaluate(
      [makeRule({ id: 'w', model: 'WRI', params: { rate: 1 } })],
      makeInput(),
    );
    expect(caught).toBeInstanceOf(FrozenViewWriteError);
    const error = await failure(
      built,
      [makeRule({ id: 'r', model: 'REP' })],
      makeInput({ requestId: 'second' }),
    );
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as UnexpectedEngineError).cause).toMatchObject({ name: 'FrozenViewWriteError' });
  });

  it('Vr: an error caught from the result view of afterEvaluate and thrown by validateParams fails', async () => {
    let caught: unknown;
    const catcher = pluginWith('catcher', {
      afterEvaluate: (_input, result) => {
        try {
          (result as { value: unknown }).value = 5;
        } catch (error) {
          caught = error;
        }
        return undefined;
      },
    });
    const replayer: CalculationModel = {
      name: 'RV',
      version: '1.0.0',
      validateParams: () => {
        throw caught;
      },
      calculate: () => 1,
    };
    const built = build([catcher, regModel('r', replayer)]);
    await built.engine.evaluate([tax()], makeInput({ requestId: 'first' }));
    expect(caught).toBeInstanceOf(FrozenViewWriteError);
    const error = await failure(
      built,
      [makeRule({ id: 'rv', model: 'RV' })],
      makeInput({ requestId: 'second' }),
    );
    expect(error).toBeInstanceOf(UnexpectedEngineError);
  });

  it('Vq2: an error a model catches and rethrows in the same call is still its refused write', async () => {
    const rethrower: CalculationModel = {
      name: 'RET',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (_input, _rule, params) => {
        try {
          (params as Record<string, number>)['rate'] = 2;
        } catch (error) {
          const again = error; // caught, kept, thrown again in the same call
          throw again;
        }
        return 1;
      },
    };
    const built = build([regModel('r', rethrower)]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'r', model: 'RET', params: { rate: 1 } })],
      makeInput(),
    );
    expect(result.skippedRules[0]).toMatchObject({ reason: 'MODEL_ERROR' });
  });
});

describe('V6: nothing that is not plain data reaches the record', () => {
  it('W1: an invalid Date in params excludes the rule and is a string in the record', async () => {
    const valid = makeRule({ id: 'bad', model: 'FLAT', params: { rate: 1 } });
    const rule = { ...valid, params: { rate: 1, at: new Date(NaN) } } as unknown as Rule;
    const built = build([]);
    const result = await built.engine.evaluate([rule], makeInput());
    expect(result.skippedRules[0]?.reason).toBe('INVALID_RULE');
    expect(result.skippedRules[0]?.detail).toContain('/params/at is an invalid Date');
    const held = (result.skippedRules[0]?.rule.params as { at: unknown }).at;
    expect(held).toBe('<invalid Date>');
    const record = JSON.stringify(built.saved[0]);
    expect(record).not.toContain('NotPlain');
    expect(record).toContain('"at":"<invalid Date>"');
  });

  it('W4: an invalid effectiveFrom excludes the rule the same way', async () => {
    const rule = makeRule({ id: 'bad', model: 'FLAT', params: { rate: 1 } });
    const broken = { ...rule, effectiveFrom: new Date(NaN) } as unknown as Rule;
    const built = build([]);
    const result = await built.engine.evaluate([broken], makeInput());
    expect(result.skippedRules[0]?.reason).toBe('INVALID_RULE');
    expect(result.skippedRules[0]?.detail).toContain('/effectiveFrom is an invalid Date');
    expect(JSON.stringify(built.saved[0])).not.toContain('NotPlain');
  });

  class Box {}
  it('W6: a hook returning a kept rule with a non-plain member in place of a string fails', async () => {
    const given = makeRule({
      id: 'k',
      model: 'FLAT',
      params: { rate: 1, tag: '<not plain: Box>' },
    });
    const sneaky = pluginWith('sneaky', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: rules.map((rule) => ({
          ...rule,
          params: { ...(rule.params as object), tag: new Box() },
        })) as Rule[],
      }),
    });
    const error = (await failure(build([sneaky]), [given])) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.message).toContain('is not a plain object: Box');
  });

  it('W7: a skip whose rule holds a non-plain member in place of a string fails', async () => {
    const given = makeRule({
      id: 'k',
      model: 'FLAT',
      params: { rate: 1, tag: '<not plain: Box>' },
    });
    const sneaky = pluginWith('sneaky', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [],
        skipped: rules.map((rule) => ({
          rule: { ...rule, params: { ...(rule.params as object), tag: new Box() } } as Rule,
          reason: 'PLUGIN' as const,
          detail: 'no',
        })),
      }),
    });
    const error = (await failure(build([sneaky]), [given])) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.message).toContain('is not a plain object: Box');
  });
});

describe('V7: the failure the caller receives is the engine own', () => {
  it('Va: a plugin cannot rewrite what it threw after the caller has the error', async () => {
    const mine = new Error('mine');
    const failing = pluginWith('failing', {
      beforeEvaluate: () => {
        throw mine;
      },
      onError: () => {
        mine.message = 'all fine';
      },
    });
    const error = (await failure(build([failing]), [tax()])) as PluginHookError;
    expect(error.cause).not.toBe(mine);
    expect((error.cause as Error).message).toBe('mine');
    expectCopyOf(error.cause, new Error('mine'));
  });

  it('Vc: a plugin cannot rewrite the error its model threw', async () => {
    const boom = new Error('boom');
    const model: CalculationModel = {
      name: 'BOOM',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => {
        throw boom;
      },
    };
    const meddler = pluginWith('meddler', {
      onError: () => {
        boom.message = 'nothing happened';
      },
    });
    const error = await failure(build([regModel('m', model), meddler]), [
      makeRule({ id: 'b', model: 'BOOM' }),
    ]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect(error).not.toBe(boom);
    expect((error as Error).message).toBe('boom');
    expect(((error as UnexpectedEngineError).cause as Error).message).toBe('boom');
  });
});

describe('V8: what a model returns is judged by what went wrong', () => {
  const modelReturning = (name: string, make: (params: unknown) => unknown): CalculationModel => ({
    name,
    version: '1.0.0',
    validateParams: () => ({ valid: true }),
    calculate: (_input, _rule, params) => make(params) as number,
  });

  it('W8: a getter of the output that throws is the model throw: the evaluation fails', async () => {
    const model = modelReturning('GET', () => ({
      get value(): number {
        throw new Error('getter boom');
      },
    }));
    const error = await failure(build([regModel('m', model)]), [
      makeRule({ id: 'g', model: 'GET' }),
    ]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect(((error as UnexpectedEngineError).cause as Error).message).toBe('getter boom');
  });

  it('W11: a getter of the output that writes into the params is a MODEL_ERROR', async () => {
    const model = modelReturning('WGET', (params) => ({
      get value(): number {
        (params as Record<string, number>)['rate'] = 9;
        return 1;
      },
    }));
    const built = build([regModel('m', model)]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'w', model: 'WGET', params: { rate: 1 } })],
      makeInput(),
    );
    expect(result.skippedRules[0]).toMatchObject({ reason: 'MODEL_ERROR' });
  });

  it('W9: an output past maxRuleLeaves is refused for that rule, naming the bound', async () => {
    const model = modelReturning('BIG', () => ({
      value: 1,
      detail: Array.from({ length: 50 }, (_, index) => index),
    }));
    const built = build([regModel('m', model)], { limits: { maxRuleLeaves: 20 } });
    const result = await built.engine.evaluate([makeRule({ id: 'b', model: 'BIG' })], makeInput());
    expect(result.skippedRules[0]?.reason).toBe('OUTPUT_MISMATCH');
    expect(result.skippedRules[0]?.detail).toContain('maxRuleLeaves');
  });
});

describe('V9: the closed view refuses a new key as every other write', () => {
  it('Vo2: preventExtensions then defineProperty of a new key is MODEL_ERROR', async () => {
    const closer: CalculationModel = {
      name: 'CLO',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (_input, _rule, params) => {
        Object.preventExtensions(params as object);
        Object.defineProperty(params as object, 'newkey', { configurable: false });
        return 1;
      },
    };
    const built = build([regModel('c', closer)]);
    const result = await built.engine.evaluate(
      [makeRule({ id: 'c', model: 'CLO', params: { rate: 1 } })],
      makeInput(),
    );
    expect(result.skippedRules[0]).toMatchObject({ reason: 'MODEL_ERROR' });
    expect(result.skippedRules[0]?.detail).toContain('newkey');
  });
});

describe('V11: survivors of round 6', () => {
  it('V27: rules a hook adds are the engine own for the next hook', async () => {
    const big = (id: string): Rule =>
      makeRule({
        id,
        model: 'FLAT',
        params: { rate: 1, list: Array.from({ length: 400 }, (_, index) => index) },
      });
    const first = pluginWith('first', {
      beforeEvaluate: (input, rules) => ({ input, rules: [...rules, big('added')] }),
    });
    const second = pluginWith('second', {
      beforeEvaluate: (input, rules) => ({ input, rules }),
    });
    const built = build([first, second], { limits: { maxHookLeaves: 700 } });
    const result = await built.engine.evaluate([tax()], makeInput());
    expect(result.appliedRules.map((rule) => rule.id).sort()).toEqual(['added', 'tax']);
  });
});
