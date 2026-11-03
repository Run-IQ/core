import { describe, it, expect, vi } from 'vitest';
import { EXCEPTION_MODEL } from '@run-iq/spec';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { SnapshotSerializer } from '../../src/snapshot/SnapshotSerializer.js';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { frozenErrorCopy } from '../../src/utils/frozenCopy.js';
import { serializedLength } from '../../src/utils/weight.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { Rule } from '../../src/types/rule.js';
import type { EvaluationInput } from '../../src/types/input.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Round 7 of the 9L audit (X1 to X9 and the rulings: one crossing point, one exact weight,
// `undefined` everywhere).

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
const regModel = (model: unknown): PPEPlugin =>
  pluginWith('reg', { onInit: (c) => c.modelRegistry.register(model as CalculationModel) });
function build(plugins: PPEPlugin[], config: Partial<PPEEngineConfig> = {}): PPEEngine {
  return new PPEEngine({
    plugins: [host, ...plugins],
    dsls: [],
    strict: false,
    snapshot: new InMemorySnapshotAdapter(),
    ...config,
  });
}
const tax = (rate = 100): Rule => makeRule({ id: 'tax', model: 'flat', params: { rate } });
async function failure(engine: PPEEngine, rules: unknown, input?: unknown): Promise<unknown> {
  return engine.evaluate(rules as Rule[], (input ?? makeInput()) as EvaluationInput).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('X1: the weight of a text is its exact serialized length', () => {
  it('counts the quotes and every escape as JSON writes it', () => {
    const cases: [string, number][] = [
      ['', 2],
      ['abc', 5],
      ['"', 4], // \"
      ['\\', 4], // \\
      ['\n', 4], // \n
      ['\t\r\b\f', 10], // four two-character escapes
      ['\u0000', 8], // \u0000
      ['\u001f', 8],
      ['\ud800', 8], // a lone surrogate is written \ud800
      ['\udc00', 8],
      ['😀', 4], // a pair is written as it is
      ['é', 3],
    ];
    for (const [text, expected] of cases) {
      expect(serializedLength(text), JSON.stringify(text)).toBe(expected);
      expect(JSON.stringify(text).length, `${JSON.stringify(text)} against JSON.stringify`).toBe(
        expected,
      );
    }
  });

  it('weighs text with escapes at what it costs, in the input', async () => {
    // Key `a`: 1 node. The string: 640 control characters = 2 + 640 * 6 = 3842 written = 60 nodes
    // of 64, plus its own: 61. In all 62.
    const engine = build([], { limits: { maxInputLeaves: 50, maxStringLength: 1000 } });
    const error = await failure(engine, [tax()], makeInput({ data: { a: '\u0001'.repeat(640) } }));
    expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 50, actual: 62 });
    // The same length in plain text weighs a sixth: it passes.
    await expect(
      engine.evaluate([tax()], makeInput({ requestId: 'plain', data: { a: 'x'.repeat(640) } })),
    ).resolves.toBeDefined();
  });

  it('T3: rules sharing a string of control characters are refused where plain text passes', async () => {
    const rules = (text: string): Rule[] =>
      Array.from({ length: 5 }, (_, index) =>
        makeRule({ id: `r${index}`, model: 'flat', params: { rate: 1, text } }),
      );
    const limits = { maxRuleSetNodes: 400, maxStringLength: 10_000 };
    const plain = build([], { limits });
    await expect(plain.evaluate(rules('x'.repeat(1000)), makeInput())).resolves.toBeDefined();
    const escaped = build([], { limits });
    const error = await failure(escaped, rules('\u0001'.repeat(1000)));
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRuleSetNodes', max: 400 });
  });

  it('refuses a record that cannot fit from the text alone, before anything is serialized', async () => {
    const serialize = vi.spyOn(SnapshotSerializer, 'serialize');
    try {
      const engine = build([], { limits: { maxRecordLength: 1000, maxStringLength: 100_000 } });
      const error = await failure(engine, [tax()], makeInput({ data: { text: 'x'.repeat(2000) } }));
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxRecordLength', max: 1000 });
      expect((error as EngineLimitError).actual).toBeGreaterThan(2000);
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      serialize.mockRestore();
    }
  });

  it('refuses rules whose text alone fills the record, before their checksums are computed', async () => {
    const engine = build([], { limits: { maxRecordLength: 1000, maxStringLength: 100_000 } });
    const big = makeRule({ id: 'big', model: 'flat', params: { rate: 1, text: 'x'.repeat(2000) } });
    const error = await failure(engine, [big]);
    expect(error).toMatchObject({ limit: 'maxRecordLength', max: 1000 });
  });
});

describe('X2: the text of a skip is read through the reader', () => {
  const skipper = (detail: unknown, count = 1) =>
    pluginWith('skipper', {
      beforeEvaluate: (input, current) => ({
        input,
        rules: [],
        skipped: current.slice(0, count).map((rule) => ({
          rule,
          reason: 'PLUGIN' as const,
          detail: detail as string,
        })),
      }),
    });
  const many = (count: number): Rule[] =>
    Array.from({ length: count }, (_, index) =>
      makeRule({ id: `r${index}`, model: 'flat', params: { rate: 1 } }),
    );

  it('Xs: a text shared by many skips is weighed each time', async () => {
    const shared = 'd'.repeat(6400); // 100 nodes each
    const engine = build([skipper(shared, 10)], {
      limits: { maxHookLeaves: 500, maxStringLength: 10_000 },
    });
    const error = (await failure(engine, many(10))) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).toBeInstanceOf(EngineLimitError);
    expect(error.cause).toMatchObject({ limit: 'maxHookLeaves', max: 500 });
  });

  it('Xn: a detail longer than maxStringLength is refused by name', async () => {
    const engine = build([skipper('d'.repeat(101))], { limits: { maxStringLength: 100 } });
    const error = (await failure(engine, many(1))) as PluginHookError;
    expect(error.cause).toMatchObject({ limit: 'maxStringLength', max: 100, actual: 101 });
  });

  it('a detail that is not a string is a malformed skip', async () => {
    const engine = build([skipper({ not: 'a string' })]);
    const error = (await failure(engine, many(1))) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error.cause as Error).message).toContain('a malformed skipped');
  });

  it('Xb5: the errors of validateParams, shared by many rules, are weighed each time', async () => {
    const wordy: CalculationModel = {
      name: 'wordy',
      version: '1.0.0',
      validateParams: () => ({ valid: false, errors: ['y'.repeat(6400)] }),
      calculate: () => 1,
    };
    const engine = build([regModel(wordy)], {
      limits: { maxHookLeaves: 250, maxStringLength: 10_000 },
    });
    const rules = Array.from({ length: 5 }, (_, index) =>
      makeRule({ id: `w${index}`, model: 'wordy' }),
    );
    const error = await failure(engine, rules);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxHookLeaves', max: 250 });
  });

  it('the text of an invalid-params detail is cut to 1 024 characters', async () => {
    const wordy: CalculationModel = {
      name: 'wordy',
      version: '1.0.0',
      validateParams: () => ({ valid: false, errors: ['y'.repeat(5000)] }),
      calculate: () => 1,
    };
    const engine = build([regModel(wordy)], { limits: { maxStringLength: 10_000 } });
    const result = await engine.evaluate([makeRule({ id: 'w', model: 'wordy' })], makeInput());
    const detail = result.skippedRules[0]?.detail ?? '';
    expect(result.skippedRules[0]?.reason).toBe('INVALID_PARAMS');
    expect(detail.length).toBeLessThan(1300);
    expect(detail).toContain('(5000 characters)');
  });
});

describe('X3: the result of validateParams crosses through the reader', () => {
  const forged = (): ValidationError =>
    new ValidationError('Invalid evaluation input', ['forged by the model']);
  const modelWith = (validateParams: CalculationModel['validateParams']): CalculationModel => ({
    name: 'vp',
    version: '1.0.0',
    validateParams,
    calculate: () => 1,
  });

  it('Xa: a forged error thrown while the result is read is never received as itself', async () => {
    const fake = forged();
    const evil = modelWith(
      () =>
        ({
          valid: false,
          errors: {
            length: 1,
            join() {
              throw fake;
            },
          },
        }) as never,
    );
    const result = await build([regModel(evil)]).evaluate(
      [makeRule({ id: 'a', model: 'vp' })],
      makeInput(),
    );
    // `errors` is not a list: a malformed result, that rule is excluded, nothing is thrown.
    expect(result.skippedRules[0]?.reason).toBe('MODEL_ERROR');
  });

  it('Xb: a getter that throws a forged error reaches the caller as a copy', async () => {
    const fake = forged();
    const evil = modelWith(
      () =>
        ({
          get valid(): boolean {
            throw fake;
          },
        }) as never,
    );
    const error = await failure(build([regModel(evil)]), [makeRule({ id: 'b', model: 'vp' })]);
    expect(error).not.toBe(fake);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as UnexpectedEngineError).cause).not.toBe(fake);
  });

  it('Xb2: `errors` is read once', async () => {
    let reads = 0;
    const evil = modelWith(
      () =>
        ({
          valid: false,
          get errors() {
            reads += 1;
            return reads === 1 ? ['first read'] : ['second read'];
          },
        }) as never,
    );
    const result = await build([regModel(evil)]).evaluate(
      [makeRule({ id: 'a', model: 'vp' })],
      makeInput(),
    );
    expect(reads).toBe(1);
    expect(result.skippedRules[0]?.detail).toContain('first read');
  });

  it('Xb3: a valid that is not a boolean is not "valid"', async () => {
    const evil = modelWith(() => ({ valid: 'no' }) as never);
    const result = await build([regModel(evil)]).evaluate(
      [makeRule({ id: 'a', model: 'vp' })],
      makeInput(),
    );
    expect(result.value).toBe(0);
    expect(result.skippedRules[0]?.reason).toBe('MODEL_ERROR');
    expect(result.skippedRules[0]?.detail).toContain('"valid" is not true or false');
  });

  it('a result with an unknown key, or that is not an object, is refused by name', async () => {
    for (const bad of [{ valid: true, extra: 1 }, 'yes', null, [true]]) {
      const evil = modelWith(() => bad as never);
      const result = await build([regModel(evil)]).evaluate(
        [makeRule({ id: 'a', model: 'vp' })],
        makeInput({ requestId: `r-${JSON.stringify(bad)}` }),
      );
      expect(result.skippedRules[0]?.reason, JSON.stringify(bad)).toBe('MODEL_ERROR');
    }
  });

  it('M5: the same holds on the exception-substitution path', async () => {
    const fake = forged();
    const evil = modelWith((params) => {
      if ((params as { y?: number }).y === 1) throw fake;
      return { valid: true };
    });
    const substitute = makeRule({
      id: 'sub',
      model: EXCEPTION_MODEL,
      priority: 9000,
      exceptions: [{ kind: 'substitute', targets: { ids: ['vp'] }, params: { y: 1 } }],
    } as never);
    const error = await failure(build([regModel(evil)]), [
      makeRule({ id: 'vp', model: 'vp', params: { y: 0 } }),
      substitute,
    ]);
    expect(error).not.toBe(fake);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
  });

  it('a malformed result on the substitution path excludes the target', async () => {
    const evil = modelWith((params) =>
      (params as { y?: number }).y === 1 ? ({ valid: 'no' } as never) : { valid: true },
    );
    const substitute = makeRule({
      id: 'sub',
      model: EXCEPTION_MODEL,
      priority: 9000,
      exceptions: [{ kind: 'substitute', targets: { ids: ['vp'] }, params: { y: 1 } }],
    } as never);
    const result = await build([regModel(evil)]).evaluate(
      [makeRule({ id: 'vp', model: 'vp', params: { y: 0 } }), substitute],
      makeInput(),
    );
    expect(result.skippedRules.find((s) => s.rule.id === 'vp')?.reason).toBe('MODEL_ERROR');
  });
});

describe('X4: undefined is refused inside lists of the meta too', () => {
  const prepare = (meta: Record<string, unknown>): unknown => {
    try {
      InputSanitizer.prepare({ requestId: 'r', data: {}, meta: { tenantId: 't', ...meta } });
      return undefined;
    } catch (error) {
      return error;
    }
  };

  it('Xx: a list item of a dimension, with its pointer', () => {
    for (const region of [[undefined], [undefined, undefined], ['TG', undefined]]) {
      const error = prepare({ dimensions: { region } });
      expect(error, JSON.stringify(region)).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).reasons.join('; ')).toContain('/meta/dimensions/region/');
      expect((error as ValidationError).reasons.join('; ')).toContain('is not JSON: undefined');
    }
  });

  it('Xj: undefined anywhere in assertions and in dates', () => {
    const inAssertions = prepare({ assertions: { '/x': undefined } });
    expect((inAssertions as ValidationError).reasons).toEqual([
      '/meta/assertions/~1x is not JSON: undefined',
    ]);
    const nested = prepare({ assertions: { '/x': { deep: [1, undefined] } } });
    expect((nested as ValidationError).reasons.join('; ')).toContain(
      '/meta/assertions/~1x/deep/1 is not JSON: undefined',
    );
  });

  it('a hole in a list of the meta is refused with its pointer', () => {
    const error = prepare({ dimensions: { region: new Array<string>(2) } });
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).reasons.join('; ')).toContain('hole');
  });

  it('a top-level member of meta that is undefined is absent, as for spec', () => {
    expect(prepare({ dimensions: undefined, effectiveDate: undefined })).toBeUndefined();
  });
});

describe('X5: the copy of a thrown value is the engine own', () => {
  it('Xd: a function is described, not kept', () => {
    const fn = Object.assign(() => 1, { message: 'secret' });
    const copy = frozenErrorCopy(fn);
    expect(typeof copy).toBe('string');
    expect(copy).not.toBe(fn);
  });

  it('Xe: a getter of message answers once; a later change shows nowhere', () => {
    let current = 'at the time';
    class Live extends Error {
      override get message(): string {
        return current;
      }
    }
    const copy = frozenErrorCopy(new Live()) as Error;
    current = 'nothing happened';
    expect(copy.message).toBe('at the time');
  });

  it('Xe2: a later change to the prototype of the plugin class shows nowhere', () => {
    class Mine extends Error {}
    const mine = new Mine('before');
    const copy = frozenErrorCopy(mine) as Error;
    Object.defineProperty(Mine.prototype, 'message', {
      get: () => 'rewritten',
      configurable: true,
    });
    expect(copy.message).toBe('before');
    expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
  });

  it('Xf: a DOMException is read without its brand', () => {
    let thrown: unknown;
    try {
      structuredClone(() => 1);
    } catch (error) {
      thrown = error;
    }
    const copy = frozenErrorCopy(thrown) as Error;
    expect(() => String(copy)).not.toThrow();
    expect(copy.name).toBe('DataCloneError');
    expect(copy.message).toContain('could not be cloned');
  });

  it('Xg: a Date is described by a string', () => {
    expect(frozenErrorCopy(new Date(0))).toBe('[object Date]');
  });

  it('Xi: the copy is bounded in nodes and in text', () => {
    const big = Object.assign(new Error('e'), {
      list: Array.from({ length: 1_000_000 }, (_, i) => i),
    });
    const start = performance.now();
    const copy = frozenErrorCopy(big) as { list: unknown[] };
    expect(performance.now() - start).toBeLessThan(500);
    expect(copy.list.length).toBeLessThanOrEqual(1001);
    const text = frozenErrorCopy(new Error('m'.repeat(1_000_000))) as Error;
    expect(text.message.length).toBeLessThan(1100);
    expect(text.message).toContain('(1000000 characters)');
  });

  it('Xi2: the nodes of all the lists and objects together are bounded, not only each list', () => {
    const lists = Object.assign(new Error('e'), {
      a: Array.from({ length: 900 }, () => [1]),
      b: Array.from({ length: 900 }, () => [2]),
    });
    const copy = frozenErrorCopy(lists) as { a: unknown[]; b: unknown[] };
    const all = [...copy.a, ...copy.b];
    expect(all.filter((item) => item === '[truncated]').length).toBeGreaterThan(0);
    expect(all.filter((item) => Array.isArray(item)).length).toBeLessThanOrEqual(1000);
  });

  it('keeps the prototype of the engine classes and of the language errors, and no other', () => {
    expect(Object.getPrototypeOf(frozenErrorCopy(new TypeError('t')))).toBe(TypeError.prototype);
    const limit = frozenErrorCopy(new EngineLimitError('maxRules', 1, 2)) as EngineLimitError;
    expect(limit).toBeInstanceOf(EngineLimitError);
    expect(limit.limit).toBe('maxRules');
  });
});

describe('X6: every channel is bounded', () => {
  it('Xm: a requestId longer than maxStringLength is refused by name', async () => {
    const engine = build([], { limits: { maxStringLength: 100 } });
    const error = await failure(engine, [tax()], makeInput({ requestId: 'r'.repeat(101) }));
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxStringLength', actual: 101 });
    expect((error as EngineLimitError).pointer).toBe('/requestId');
  });

  it('a pointer in the message of a limit error is cut to 1 024 characters', () => {
    const error = new EngineLimitError('maxStringLength', 10, 11, `/data/${'k'.repeat(5000)}`);
    expect(error.message.length).toBeLessThan(1200);
    expect(error.message).toContain('characters)');
    expect(error.pointer?.length).toBeLessThan(1100);
  });
});

describe('X7: the trace bound and the input bound', () => {
  it('Xt: an input of a hundred thousand nodes with twenty rules is evaluated', async () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < 49_999; i += 1) data[`k${i}`] = i;
    const rules = Array.from({ length: 20 }, (_, i) => makeRule({ id: `r${i}`, model: 'm' }));
    const result = await build([]).evaluate(rules, makeInput({ data }));
    expect(result.appliedRules).toHaveLength(20);
  });

  it('M29: the input a hook returns is what the trace bound counts', async () => {
    // The input has 4 nodes (data { a: 1 } and the tenant); the hook grows it to 6 + tenant: the
    // product with two steps passes the bound only if the hook's input is the one counted.
    const grow = pluginWith('grow', {
      beforeEvaluate: (input, current) => ({
        input: { ...input, data: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 } },
        rules: current,
      }),
    });
    const rules = [
      makeRule({ id: 'a', model: 'flat', params: { rate: 1 } }),
      makeRule({ id: 'b', model: 'flat', params: { rate: 2 } }),
    ];
    // Before the hook: 2 + 2 = 4 nodes, times 2 steps = 8. After: 16 + 2 = 18, times 2 = 36.
    const engine = build([grow], { limits: { maxTraceNodes: 20 } });
    const error = await failure(engine, rules, makeInput({ data: { a: 1 } }));
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxTraceNodes', max: 20, actual: 36 });
  });
});

describe('X9: survivors of round 7', () => {
  it('M28: a RangeError while cloning the record is the named limit', () => {
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    try {
      expect(() =>
        SnapshotSerializer.serialize(makeInput(), [], {} as never, {} as never, '1', {}, {}, 1000),
      ).toThrow(EngineLimitError);
    } finally {
      clone.mockRestore();
    }
  });

  it('a clone failure that is not a RangeError is not turned into a limit', () => {
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
      throw new TypeError('not cloneable');
    });
    try {
      expect(() =>
        SnapshotSerializer.serialize(makeInput(), [], {} as never, {} as never, '1', {}, {}, 1000),
      ).toThrow(TypeError);
    } finally {
      clone.mockRestore();
    }
  });

  it('the defaults are the calibrated ones', () => {
    expect(DEFAULT_LIMITS).toMatchObject({
      maxRuleSetNodes: 2_000_000,
      maxHookLeaves: 400_000,
      maxStringLength: 1_000_000,
      maxRecordLength: 256_000_000,
      maxTraceNodes: 10_000_000,
    });
  });
});
