import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { DSLTimeoutError } from '../../src/errors/DSLTimeoutError.js';
import { RuleValidator } from '../../src/security/RuleValidator.js';
import { SnapshotSerializer } from '../../src/snapshot/SnapshotSerializer.js';
import { isReading } from '../../src/engine/pluginPort.js';
import { NAME_PATTERN, VERSION_PATTERN } from '../../src/engine/pluginPort.js';
import type { PPEPlugin } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { EvaluationInput } from '../../src/types/input.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Round 8 of the 9L audit (Z1 to Z10 and the rulings: the hostile Proxy test, plugin faults as
// text, identity read once at registration, promises, `afterEvaluate` inside the one budget).

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
});

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
  onInit(context): void {
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
const tax = (rate = 100, id = 'tax'): Rule => makeRule({ id, model: 'FLAT', params: { rate } });
async function failure(engine: PPEEngine, rules: unknown, input?: unknown): Promise<unknown> {
  return engine.evaluate(rules as Rule[], (input ?? makeInput()) as EvaluationInput).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('Z1: an engine error a plugin built is a plugin fault', () => {
  const dslWith = (listVariables: NonNullable<DSLEvaluator['listVariables']>): DSLEvaluator => ({
    dsl: 'forgedsl',
    version: '1.0.0',
    evaluate: () => true,
    listVariables,
  });
  const conditioned = makeRule({
    id: 'c',
    model: 'FLAT',
    params: { rate: 1 },
    condition: { dsl: 'forgedsl', value: {} },
  });

  it('Za2: a DSL listVariables that throws an EngineLimitError is a problem, not the caller error', async () => {
    const fake = new EngineLimitError('maxRules', 1, 2);
    const dsl = dslWith(() => {
      throw fake;
    });
    const result = await build([], {}, [dsl]).evaluate([conditioned], makeInput());
    expect(result.diagnostics.map((d) => d.message).join(' ')).toContain('engine limit maxRules');
  });

  it('Za3: validateParams throwing an EngineLimitError of the budget fails with an engine error', async () => {
    const fake = new EngineLimitError('maxHookLeaves', 1, 2);
    const evil: CalculationModel = {
      name: 'EVIL',
      version: '1.0.0',
      validateParams: () => {
        throw fake;
      },
      calculate: () => 1,
    };
    const error = await failure(build([regModel(evil)]), [makeRule({ id: 'e', model: 'EVIL' })]);
    expect(error).not.toBe(fake);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as UnexpectedEngineError).cause).toMatchObject({ name: 'EngineLimitError' });
  });

  it('Za4: validateParams throwing another EngineLimitError is the model own throw: the evaluation fails', async () => {
    const evil: CalculationModel = {
      name: 'EVIL',
      version: '1.0.0',
      validateParams: () => {
        throw new EngineLimitError('maxRules', 1, 2);
      },
      calculate: () => 1,
    };
    const error = await failure(build([regModel(evil)]), [
      makeRule({ id: 'e', model: 'EVIL' }),
      tax(),
    ]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
  });

  it('Za9: a DSLTimeoutError a DSL built is a DSL_ERROR with a cut message, not a timeout', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'forgedsl',
      version: '1.0.0',
      evaluate: () => {
        throw new DSLTimeoutError('forgedsl', 1);
      },
    };
    const huge: DSLEvaluator = {
      ...dsl,
      dsl: 'hugedsl',
      evaluate: () => {
        throw Object.assign(new DSLTimeoutError('hugedsl', 1), { message: 'm'.repeat(5_000_000) });
      },
    };
    const rules = [
      conditioned,
      makeRule({
        id: 'h',
        model: 'FLAT',
        params: { rate: 1 },
        condition: { dsl: 'hugedsl', value: {} },
      }),
    ];
    const result = await build([], {}, [dsl, huge]).evaluate(rules, makeInput());
    const reasons = result.skippedRules.map((skip) => skip.reason);
    expect(reasons).toEqual(['DSL_ERROR', 'DSL_ERROR']);
    for (const skip of result.skippedRules) expect(skip.detail?.length).toBeLessThan(1300);
  });

  it('Za10: the texts of many DSL faults are weighed against the one budget', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'forgedsl',
      version: '1.0.0',
      evaluate: () => {
        throw new Error('e'.repeat(5000));
      },
    };
    const many = Array.from({ length: 6 }, (_, i) =>
      makeRule({
        id: `c${i}`,
        model: 'FLAT',
        params: { rate: 1 },
        condition: { dsl: 'forgedsl', value: {} },
      }),
    );
    const error = await failure(build([], { limits: { maxHookLeaves: 60 } }, [dsl]), many);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxHookLeaves', max: 60 });
  });
});

describe('Z2 to Z3: afterEvaluate is inside the one budget and the record room', () => {
  const setting = (annotations: Record<string, unknown>) =>
    pluginWith('annotator', {
      afterEvaluate: () => ({ annotations: annotations as never }),
    });

  it('Zb1: a meta of 10 000 keys is refused by the budget', async () => {
    const meta: Record<string, number> = {};
    for (let i = 0; i < 10_000; i += 1) meta[`k${i}`] = i;
    const error = (await failure(
      build([setting(meta)], { limits: { maxHookLeaves: 100 } }),
      [],
    )) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).toMatchObject({ limit: 'maxHookLeaves', max: 100 });
  });

  it('Zb3: texts that JSON escapes are weighed in a meta', async () => {
    // Two strings of 6 400 control characters: 600 nodes each.
    const meta = { a: '\u0001'.repeat(6400), b: '\u0001'.repeat(6400) };
    const error = (await failure(
      build([setting(meta)], { limits: { maxHookLeaves: 1000, maxStringLength: 10_000 } }),
      [],
    )) as PluginHookError;
    expect(error.cause).toMatchObject({ limit: 'maxHookLeaves', max: 1000 });
  });

  it('W3: several afterEvaluate plugins share one budget', async () => {
    const some = (name: string): PPEPlugin =>
      pluginWith(name, {
        afterEvaluate: () => ({ annotations: { list: Array.from({ length: 200 }, (_, i) => i) } }),
      });
    const limits = { maxHookLeaves: 800 };
    await expect(
      build([some('one'), some('two'), some('three')], { limits }).evaluate([], makeInput()),
    ).resolves.toBeDefined();
    const error = (await failure(
      build([some('one'), some('two'), some('three'), some('four'), some('five')], { limits }),
      [],
      makeInput({ requestId: 'five' }),
    )) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error.cause).toMatchObject({ limit: 'maxHookLeaves', max: 800 });
  });

  it('the text a plugin sets in meta counts in the record room, before the record is built', async () => {
    const serialize = vi.spyOn(SnapshotSerializer, 'serialize');
    try {
      const error = await failure(
        build([setting({ text: 'x'.repeat(2000) })], {
          limits: { maxRecordLength: 1500, maxStringLength: 10_000 },
        }),
        [],
      );
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxRecordLength', max: 1500 });
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      serialize.mockRestore();
    }
  });
});

describe('Z4: the identity of a plugin, a model and a DSL is read once, at registration', () => {
  it('Zc1, Zc2, Zc3: a version past the bound, or not a string, refuses the registration naming it', () => {
    for (const version of ['1'.repeat(65), { toJSON: () => 1 }, 7, 'not semver']) {
      const plugin = { ...pluginWith('p', {}), version } as unknown as PPEPlugin;
      expect(() => build([plugin])).toThrow(/version/);
    }
  });

  it('Zc6: a DSL version that is an object is refused', () => {
    const dsl = { dsl: 'd', version: { text: 'x'.repeat(100) }, evaluate: () => true };
    expect(() => build([], {}, [dsl as unknown as DSLEvaluator])).toThrow(/DSL d: version/);
  });

  it('a model version that is an object is refused', () => {
    const model = { ...FLAT, name: 'OBJ', version: {} } as unknown as CalculationModel;
    expect(() => build([regModel(model)])).toThrow(/model OBJ: version/);
  });

  it('Zc5: a name is read once: the attribution is the plugin own first answer, whatever it answers later', async () => {
    let reads = 0;
    const shifty = {
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: () => {
        throw new Error('boom');
      },
      get name(): string {
        reads += 1;
        return reads === 1 ? 'evil' : 'trusted';
      },
    } as unknown as PPEPlugin;
    const engine = build([shifty]);
    const error = (await failure(engine, [])) as PluginHookError;
    expect(error.plugin).toBe('evil');
    expect(reads).toBe(1);
  });

  it('refuses names the engine would not keep, naming the field', () => {
    for (const name of [
      '',
      'has space',
      'x'.repeat(129),
      '-leading',
      'tab\tname',
      'Fiscal',
      '@scope/x',
      'a..b',
      'a/b',
      '__proto__',
      '@',
    ]) {
      const plugin = { ...pluginWith('p', {}), name } as PPEPlugin;
      expect(() => build([plugin]), JSON.stringify(name)).toThrow(/name/);
    }
    for (const name of ['fiscal', 'fiscal-vat', 'a.b-c_d', 'x'.repeat(128)]) {
      expect(NAME_PATTERN.test(name), name).toBe(true);
    }
    // The official SemVer 2.0.0 expression: no leading zeros, three parts.
    for (const version of ['1.0.0', '1.0.0-rc.1', '2.1.0+build.5', '0.0.0-alpha.1+001']) {
      expect(VERSION_PATTERN.test(version), version).toBe(true);
    }
    for (const version of [
      '1',
      '1.0',
      '01.2.3',
      '1.0.0-',
      '1.0.0+..',
      '1.0.0-+-',
      '1'.repeat(21),
    ]) {
      expect(VERSION_PATTERN.test(version), version).toBe(false);
    }
  });

  it('a function member that is not a function is refused at registration', () => {
    const plugin = { ...pluginWith('p', {}), beforeEvaluate: 'nope' } as unknown as PPEPlugin;
    expect(() => build([plugin])).toThrow(/beforeEvaluate must be a function/);
  });
});

describe('Z5 to Z7: what the caller keeps of a plugin fault is text', () => {
  it('Zd1: a thrown graph is never copied: the cause holds a name, a message and a code', async () => {
    const graph = Object.assign(new Error('graph'), {
      lists: Array.from({ length: 1000 }, () =>
        Array.from({ length: 1000 }, () => 'y'.repeat(1024)),
      ),
      code: 'E_GRAPH',
    });
    const bad = pluginWith('bad', {
      beforeEvaluate: () => {
        throw graph;
      },
    });
    const error = (await failure(build([bad]), [])) as PluginHookError;
    expect(Object.keys(error.cause as object).sort()).toEqual(['code', 'message', 'name']);
    expect(JSON.stringify(error.cause).length).toBeLessThan(300);
  });

  it('Zd2: a shared-reference graph does not hang whoever prints the error', async () => {
    const shared: unknown[] = [];
    let level: unknown[] = shared;
    for (let i = 0; i < 3; i += 1) {
      level = Array.from({ length: 1000 }, () => level);
    }
    const bad = pluginWith('bad', {
      beforeEvaluate: () => {
        throw Object.assign(new Error('dag'), { level });
      },
    });
    const error = await failure(build([bad]), []);
    const started = performance.now();
    JSON.stringify(error);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('clips name, message and code with a visible marker', async () => {
    const bad = pluginWith('bad', {
      beforeEvaluate: () => {
        throw Object.assign(new Error('m'.repeat(5000)), {
          name: 'N'.repeat(500),
          code: 'C'.repeat(200),
        });
      },
    });
    const cause = ((await failure(build([bad]), [])) as PluginHookError).cause as {
      name: string;
      message: string;
      code: string;
    };
    expect(cause.name).toHaveLength(128 + '... [clipped]'.length);
    expect(cause.message).toHaveLength(1024 + '... [clipped]'.length);
    expect(cause.code).toHaveLength(64 + '... [clipped]'.length);
    expect(cause.message.endsWith('... [clipped]')).toBe(true);
  });

  it('Zd3, Zd4: the message of the caller error is built from the text that is kept, read once', async () => {
    let reads = 0;
    const bad = pluginWith('bad', {
      beforeEvaluate: () => {
        throw {
          name: 'Custom',
          get message(): string {
            reads += 1;
            return reads === 1 ? 'first answer' : 'second answer';
          },
        };
      },
    });
    const error = (await failure(build([bad]), [])) as PluginHookError;
    expect(reads).toBe(1);
    expect(error.message).toBe('plugin bad beforeEvaluate failed: first answer');
    expect((error.cause as { message: string }).message).toBe('first answer');
    const long = pluginWith('long', {
      beforeEvaluate: () => {
        throw new Error('m'.repeat(20_000_000));
      },
    });
    const huge = (await failure(build([long]), [], makeInput({ requestId: 'long' }))) as Error;
    expect(huge.message.length).toBeLessThan(1200);
  });

  it('Zd5: the engine mark cannot be forged: a plugin class keeps no prototype of its own', async () => {
    expect(Object.getOwnPropertySymbols(ValidationError)).toEqual([]);
    expect(Object.getOwnPropertySymbols(EngineLimitError)).toEqual([]);
    class Mine extends Error {
      override toString(): string {
        return 'plugin code ran on print';
      }
    }
    const bad = pluginWith('bad', {
      beforeEvaluate: () => {
        throw new Mine('mine');
      },
    });
    const cause = ((await failure(build([bad]), [])) as PluginHookError).cause as object;
    expect(cause).not.toBeInstanceOf(Mine);
    expect(String(cause)).not.toContain('plugin code ran');
  });
});

describe('Z8: promises', () => {
  it('Ze1: an async onInit that rejects fails the construction and leaves no unhandled rejection', async () => {
    const asyncInit = pluginWith('p', {
      onInit: (async () => {
        throw new Error('async init');
      }) as never,
    });
    expect(() => build([asyncInit])).toThrow(PluginHookError);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(unhandled).toEqual([]);
  });

  it('Ze2, Ze3, Ze4: validateParams, calculate and onError that reject are handled', async () => {
    const reject = (): Promise<never> => Promise.reject(new Error('late'));
    const m1: CalculationModel = { ...FLAT, name: 'V1', validateParams: reject as never };
    const m2: CalculationModel = { ...FLAT, name: 'C1', calculate: reject as never };
    for (const [model, id] of [
      [m1, 'V1'],
      [m2, 'C1'],
    ] as const) {
      const failing = pluginWith('failing', {
        onError: reject as never,
      });
      const error = await failure(
        build([regModel(model), failing]),
        [makeRule({ id: 'x', model: id, params: { rate: 1 } })],
        makeInput({ requestId: `r-${id}` }),
      );
      expect(error).toBeInstanceOf(UnexpectedEngineError);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(unhandled).toEqual([]);
  });
});

describe('Z9: onError is handed the engine own frozen input', () => {
  it('Zg1: writes by onError do not reach the caller input', async () => {
    const input = makeInput({ data: { amount: 5 } });
    let handed: unknown;
    const meddler = pluginWith('meddler', {
      beforeEvaluate: () => {
        throw new Error('fail');
      },
      onError: (_error, given) => {
        handed = given;
        try {
          (given.data as Record<string, unknown>)['amount'] = 0;
          (given as { requestId: string }).requestId = 'rewritten';
        } catch {
          // frozen
        }
      },
    });
    await failure(build([meddler]), [], input);
    expect(handed).not.toBe(input);
    expect(handed).toEqual(input);
    expect((input.data as { amount: number }).amount).toBe(5);
    expect(input.requestId).toBe('test-request-001');
  });
});

describe('Z10: survivors and the rest of the table', () => {
  it('R11: errors that are not strings make the answer malformed', async () => {
    for (const errors of [[5], [{}], [null]]) {
      const evil: CalculationModel = {
        name: 'EVIL',
        version: '1.0.0',
        validateParams: () => ({ valid: false, errors }) as never,
        calculate: () => 1,
      };
      const result = await build([regModel(evil)]).evaluate(
        [makeRule({ id: 'e', model: 'EVIL' })],
        makeInput({ requestId: `r-${JSON.stringify(errors)}` }),
      );
      expect(result.skippedRules[0]?.reason, JSON.stringify(errors)).toBe('MODEL_ERROR');
    }
  });

  it('R24: rules whose text cannot fit are refused before any checksum is verified', async () => {
    const validate = vi.spyOn(RuleValidator.prototype, 'validate');
    try {
      const big = makeRule({
        id: 'big',
        model: 'FLAT',
        params: { rate: 1, text: 'x'.repeat(2000) },
      });
      const error = await failure(
        build([], { limits: { maxRecordLength: 1000, maxStringLength: 100_000 } }),
        [big],
      );
      expect(error).toMatchObject({ limit: 'maxRecordLength' });
      expect(validate).not.toHaveBeenCalled();
    } finally {
      validate.mockRestore();
    }
  });

  it('R28: the text of a listVariables answer counts against the one budget', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'ld',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: () => ['/' + 'p'.repeat(6400)],
    };
    const many = Array.from({ length: 6 }, (_, i) =>
      makeRule({
        id: `l${i}`,
        model: 'FLAT',
        params: { rate: 1 },
        condition: { dsl: 'ld', value: {} },
      }),
    );
    const error = await failure(
      build([], { limits: { maxHookLeaves: 250, maxStringLength: 10_000 } }, [dsl]),
      many,
    );
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxHookLeaves', max: 250 });
  });

  it('R29: the message of a DSL error is cut', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'wordy',
      version: '1.0.0',
      evaluate: () => {
        throw new Error('w'.repeat(10_000));
      },
    };
    const result = await build([], {}, [dsl]).evaluate(
      [
        makeRule({
          id: 'w',
          model: 'FLAT',
          params: { rate: 1 },
          condition: { dsl: 'wordy', value: {} },
        }),
      ],
      makeInput(),
    );
    expect(result.skippedRules[0]?.detail?.length).toBeLessThan(1300);
    expect(result.skippedRules[0]?.detail).toMatch(/clipped|characters\)/);
  });

  it('the port is closed outside a call: nothing is left reading', () => {
    expect(isReading()).toBe(false);
  });
});
