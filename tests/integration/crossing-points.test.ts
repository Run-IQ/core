import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { CROSSING_POINTS, Budget } from '../../src/engine/pluginBoundary.js';
import type { CrossingPoint, PluginCallback } from '../../src/engine/pluginBoundary.js';
import { readsOf } from '../../src/context/reads.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { resolveLimits } from '../../src/limits.js';
import type { EngineLimitsInput } from '../../src/limits.js';
import type { PPEPlugin } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, makeInput } from '../helpers.js';

// The inventory of the crossing points (round 7, ruling 1): every callback a plugin can give is an
// entry of `CROSSING_POINTS`; each entry the engine calls gets three probes here, and each entry it
// does not call is looked for in the source. A callback added to `PPEPlugin`, `CalculationModel` or
// `DSLEvaluator` without an entry is a compile error (the type of the inventory), and one added
// with an entry but without a harness here fails this file.

const forged = (): ValidationError =>
  new ValidationError('Invalid evaluation input', ['forged by a plugin']);

const model = (name: string, parts: Partial<CalculationModel>): CalculationModel => ({
  name,
  version: '1.0.0',
  validateParams: () => ({ valid: true }),
  calculate: () => 1,
  ...parts,
});
const registering =
  (...models: CalculationModel[]): PPEPlugin['onInit'] =>
  (context) => {
    for (const one of models) context.modelRegistry.register(one);
  };
const plugin = (name: string, hooks: Partial<PPEPlugin>): PPEPlugin => ({
  name,
  version: '1.0.0',
  onInit: () => undefined,
  ...hooks,
});

function engine(
  plugins: PPEPlugin[],
  limits: EngineLimitsInput = {},
  dsls: DSLEvaluator[] = [],
  extra: Partial<PPEEngineConfig> = {},
): PPEEngine {
  return new PPEEngine({ plugins, dsls, strict: false, limits, ...extra });
}
const rules = (count: number, modelName: string, extra: Partial<Rule> = {}): Rule[] =>
  Array.from({ length: count }, (_, index) =>
    makeRule({ id: `r${index}`, model: modelName, ...extra }),
  );
async function outcome(run: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

interface Probes {
  /** An oversized value: the named limit, or (for a thrown value) a bounded copy. */
  readonly oversized: () => Promise<void>;
  /** A forged engine error: the caller never receives it as itself. */
  readonly forged: () => Promise<void>;
  /** An `undefined` hidden in a list: refused with its pointer. */
  readonly hidden: () => Promise<void>;
}
type Harness = Partial<Record<PluginCallback, Probes>>;

/** A text far past any bound a test sets. */
const BIG = 'x'.repeat(5000);

const harness: Harness = {
  'PPEPlugin.onInit': {
    oversized: async () => {
      const big = Object.assign(new Error(BIG), {
        list: Array.from({ length: 5000 }, (_, i) => i),
      });
      const error = (await outcome(() =>
        engine([
          plugin('p', {
            onInit: () => {
              throw big;
            },
          }),
        ]),
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(error).toMatchObject({ hook: 'onInit', plugin: 'p' });
      const cause = error.cause as { message: string; list: unknown[] };
      expect(cause.message.length).toBeLessThan(1100);
      expect(cause.list.length).toBeLessThanOrEqual(1001);
    },
    forged: async () => {
      const fake = forged();
      const error = await outcome(() =>
        engine([
          plugin('p', {
            onInit: () => {
              throw fake;
            },
          }),
        ]),
      );
      expect(error).not.toBe(fake);
      expect(error).toBeInstanceOf(PluginHookError);
    },
    hidden: async () => {
      // Nothing is read from onInit: a thrown value is copied, not refused.
      const error = (await outcome(() =>
        engine([
          plugin('p', {
            onInit: () => {
              throw { list: [1, undefined] };
            },
          }),
        ]),
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
    },
  },

  'PPEPlugin.beforeEvaluate': {
    oversized: async () => {
      const bad = plugin('bad', {
        beforeEvaluate: (input, current) => ({ input, rules: current, state: { text: BIG } }),
      });
      const error = (await outcome(() =>
        engine([bad], { maxStringLength: 100 }).evaluate([], makeInput()),
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(error.cause).toBeInstanceOf(EngineLimitError);
      expect(error.cause).toMatchObject({ limit: 'maxStringLength', max: 100 });
    },
    forged: async () => {
      const fake = forged();
      const bad = plugin('bad', {
        beforeEvaluate: () => {
          throw fake;
        },
      });
      const error = await outcome(() => engine([bad]).evaluate([], makeInput()));
      expect(error).not.toBe(fake);
      expect(error).toBeInstanceOf(PluginHookError);
      expect((error as PluginHookError).cause).not.toBe(fake);
    },
    hidden: async () => {
      const bad = plugin('bad', {
        beforeEvaluate: (input, current) => ({
          input: { ...input, data: { list: [1, undefined] } },
          rules: current,
        }),
      });
      const error = (await outcome(() =>
        engine([bad]).evaluate([], makeInput()),
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect((error.cause as ValidationError).reasons.join('; ')).toContain('/data/list/1');
    },
  },

  'PPEPlugin.afterEvaluate': {
    oversized: async () => {
      const bad = plugin('bad', {
        afterEvaluate: (_input, result) => ({ ...result, meta: { text: BIG } }),
      });
      const error = (await outcome(() =>
        engine([bad], { maxStringLength: 100 }).evaluate([], makeInput()),
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(error.cause).toMatchObject({ limit: 'maxStringLength', max: 100 });
    },
    forged: async () => {
      const fake = forged();
      const bad = plugin('bad', {
        afterEvaluate: () => {
          throw fake;
        },
      });
      const error = await outcome(() => engine([bad]).evaluate([], makeInput()));
      expect(error).not.toBe(fake);
      expect(error).toBeInstanceOf(PluginHookError);
    },
    hidden: async () => {
      const bad = plugin('bad', {
        afterEvaluate: (_input, result) => ({ ...result, meta: { list: [1, undefined] } }),
      });
      const error = (await outcome(() =>
        engine([bad]).evaluate([], makeInput()),
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(String((error.cause as Error).message)).toContain('1');
    },
  },

  'PPEPlugin.onError': {
    oversized: async () => {
      // onError returns nothing that is read; what it is handed is a bounded copy.
      let told: unknown;
      const failing = plugin('failing', {
        beforeEvaluate: () => {
          throw Object.assign(new Error(BIG), { list: Array.from({ length: 5000 }, (_, i) => i) });
        },
        onError: (error) => {
          told = error;
        },
      });
      await outcome(() => engine([failing]).evaluate([], makeInput()));
      const cause = (told as { cause: { message: string; list: unknown[] } }).cause;
      expect(cause.message.length).toBeLessThan(1100);
      expect(cause.list.length).toBeLessThanOrEqual(1001);
    },
    forged: async () => {
      // A throw of onError is swallowed: the caller gets the evaluation's own error, not that one.
      const fake = forged();
      const failing = plugin('failing', {
        beforeEvaluate: () => {
          throw new Error('real');
        },
        onError: () => {
          throw fake;
        },
      });
      const error = await outcome(() => engine([failing]).evaluate([], makeInput()));
      expect(error).not.toBe(fake);
      expect(error).toBeInstanceOf(PluginHookError);
    },
    hidden: async () => {
      // Nothing is read from onError's return value.
      const failing = plugin('failing', {
        beforeEvaluate: () => {
          throw new Error('real');
        },
        onError: (() => [1, undefined]) as unknown as NonNullable<PPEPlugin['onError']>,
      });
      const error = await outcome(() => engine([failing]).evaluate([], makeInput()));
      expect(error).toBeInstanceOf(PluginHookError);
    },
  },

  'CalculationModel.validateParams': {
    oversized: async () => {
      // Five rules whose model answers with the same 100-node text: the one budget refuses it.
      const wordy = model('WORDY', {
        validateParams: () => ({ valid: false, errors: ['y'.repeat(6400)] }),
      });
      const error = await outcome(() =>
        engine([plugin('m', { onInit: registering(wordy) })], {
          maxHookLeaves: 250,
          maxStringLength: 10_000,
        }).evaluate(rules(5, 'WORDY'), makeInput()),
      );
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxHookLeaves', max: 250 });
    },
    forged: async () => {
      const fake = forged();
      const throwing = model('THROW', {
        validateParams: () => {
          throw fake;
        },
      });
      const getter = model('GETTER', {
        validateParams: () => ({
          get valid(): boolean {
            throw fake;
          },
        }),
      });
      for (const [name, one] of [
        ['THROW', throwing],
        ['GETTER', getter],
      ] as const) {
        const error = await outcome(() =>
          engine([plugin('m', { onInit: registering(one) })]).evaluate(rules(1, name), makeInput()),
        );
        expect(error).not.toBe(fake);
        expect(error).toBeInstanceOf(UnexpectedEngineError);
      }
    },
    hidden: async () => {
      const holey = model('HOLEY', {
        validateParams: () => ({ valid: true, errors: [undefined] }) as never,
      });
      const result = await engine([plugin('m', { onInit: registering(holey) })]).evaluate(
        rules(1, 'HOLEY'),
        makeInput(),
      );
      expect(result.skippedRules[0]?.reason).toBe('MODEL_ERROR');
      expect(result.skippedRules[0]?.detail).toContain('/errors/0');
    },
  },

  'CalculationModel.calculate': {
    oversized: async () => {
      // Ten rules whose outputs are one node each: the one budget refuses the eleventh node.
      const error = await outcome(() =>
        engine([plugin('m', { onInit: registering(model('ONE', {})) })], {
          maxHookLeaves: 5,
        }).evaluate(rules(10, 'ONE'), makeInput()),
      );
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxHookLeaves', max: 5 });
    },
    forged: async () => {
      const fake = forged();
      const throwing = model('THROW', {
        calculate: () => {
          throw fake;
        },
      });
      const error = await outcome(() =>
        engine([plugin('m', { onInit: registering(throwing) })]).evaluate(
          rules(1, 'THROW'),
          makeInput(),
        ),
      );
      expect(error).not.toBe(fake);
      expect(error).toBeInstanceOf(UnexpectedEngineError);
    },
    hidden: async () => {
      const holey = model('HOLEY', { calculate: () => ({ value: [1, undefined] }) as never });
      const result = await engine([plugin('m', { onInit: registering(holey) })]).evaluate(
        rules(1, 'HOLEY'),
        makeInput(),
      );
      expect(result.skippedRules[0]?.reason).toBe('OUTPUT_MISMATCH');
      expect(result.skippedRules[0]?.detail).toContain('/value/1');
    },
  },

  'CalculationModel.listVariables': {
    oversized: async () => {
      const long = model('LONG', { listVariables: () => ['/' + BIG] });
      const crossing = {
        limits: resolveLimits({ maxStringLength: 100 }),
        budget: new Budget('maxHookLeaves', 1_000_000),
      };
      const error = await outcome(() =>
        readsOf(makeRule({ id: 'a', model: 'LONG' }), undefined, long, crossing),
      );
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxStringLength' });
    },
    forged: async () => {
      const fake = forged();
      const throwing = model('THROW', {
        listVariables: () => {
          throw fake;
        },
      });
      const reads = readsOf(makeRule({ id: 'a', model: 'THROW' }), undefined, throwing);
      expect(reads.problems[0]?.kind).toBe('failed');
      expect(JSON.stringify(reads)).not.toContain('forged by a plugin" ]');
    },
    hidden: async () => {
      const holey = model('HOLEY', {
        listVariables: () => ['/a', undefined] as never,
      });
      const reads = readsOf(makeRule({ id: 'a', model: 'HOLEY' }), undefined, holey);
      expect(reads.problems[0]?.kind).toBe('failed');
      expect(reads.problems[0]?.message).toContain('/1');
    },
  },

  'DSLEvaluator.evaluate': {
    oversized: async () => {
      const wordy: DSLEvaluator = { dsl: 'w', version: '1', evaluate: () => BIG as never };
      const withCondition = makeRule({
        id: 'c',
        model: 'ONE',
        condition: { dsl: 'w', value: {} },
      });
      const error = await outcome(() =>
        engine([plugin('m', { onInit: registering(model('ONE', {})) })], { maxStringLength: 100 }, [
          wordy,
        ]).evaluate([withCondition], makeInput()),
      );
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxStringLength' });
    },
    forged: async () => {
      const fake = forged();
      const throwing: DSLEvaluator = {
        dsl: 't',
        version: '1',
        evaluate: () => {
          throw fake;
        },
      };
      const rule = makeRule({ id: 'c', model: 'ONE', condition: { dsl: 't', value: {} } });
      const result = await engine([plugin('m', { onInit: registering(model('ONE', {})) })], {}, [
        throwing,
      ]).evaluate([rule], makeInput());
      expect(result.skippedRules[0]?.reason).toBe('DSL_ERROR');
    },
    hidden: async () => {
      const holey: DSLEvaluator = {
        dsl: 'h',
        version: '1',
        evaluate: () => [1, undefined] as never,
      };
      const rule = makeRule({ id: 'c', model: 'ONE', condition: { dsl: 'h', value: {} } });
      const result = await engine([plugin('m', { onInit: registering(model('ONE', {})) })], {}, [
        holey,
      ]).evaluate([rule], makeInput());
      expect(result.skippedRules[0]?.reason).toBe('DSL_ERROR');
      expect(result.skippedRules[0]?.detail).toContain('/1');
    },
  },

  'DSLEvaluator.listVariables': {
    oversized: async () => {
      const dsl: DSLEvaluator = {
        dsl: 'l',
        version: '1',
        evaluate: () => true,
        listVariables: () => ['/' + BIG],
      };
      const crossing = {
        limits: resolveLimits({ maxStringLength: 100 }),
        budget: new Budget('maxHookLeaves', 1_000_000),
      };
      const rule = makeRule({ id: 'c', model: 'ONE', condition: { dsl: 'l', value: {} } });
      const error = await outcome(() => readsOf(rule, dsl, undefined, crossing));
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxStringLength' });
    },
    forged: async () => {
      const fake = forged();
      const dsl: DSLEvaluator = {
        dsl: 'l',
        version: '1',
        evaluate: () => true,
        listVariables: () => {
          throw fake;
        },
      };
      const rule = makeRule({ id: 'c', model: 'ONE', condition: { dsl: 'l', value: {} } });
      const reads = readsOf(rule, dsl, undefined);
      expect(reads.problems[0]?.kind).toBe('failed');
    },
    hidden: async () => {
      const dsl: DSLEvaluator = {
        dsl: 'l',
        version: '1',
        evaluate: () => true,
        listVariables: () => ['/a', undefined] as never,
      };
      const rule = makeRule({ id: 'c', model: 'ONE', condition: { dsl: 'l', value: {} } });
      const reads = readsOf(rule, dsl, undefined);
      expect(reads.problems[0]?.kind).toBe('failed');
      expect(reads.problems[0]?.message).toContain('/1');
    },
  },
};

/** Every `.ts` file under `src`. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('the inventory of crossing points', () => {
  const entries = Object.entries(CROSSING_POINTS) as [PluginCallback, CrossingPoint][];

  it('names every callback, each with what it reads', () => {
    for (const [, point] of entries) expect(point.reads.length).toBeGreaterThan(10);
    expect(entries.length).toBeGreaterThanOrEqual(14);
  });

  it('has a harness, with the three probes, for each callback the engine calls', () => {
    const called = entries.filter(([, point]) => point.called).map(([name]) => name);
    expect(Object.keys(harness).sort()).toEqual([...called].sort());
    for (const name of called) {
      const probes = harness[name] as Probes;
      expect(typeof probes.oversized).toBe('function');
      expect(typeof probes.forged).toBe('function');
      expect(typeof probes.hidden).toBe('function');
    }
  });

  it('finds no call of a callback the inventory says nothing calls', () => {
    const text = sources('src')
      .filter((path) => !path.includes('src/types/'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const [name, point] of entries) {
      if (point.called) continue;
      const method = name.split('.')[1] as string;
      expect(text, `${name} is called but the inventory says it is not`).not.toMatch(
        new RegExp(`\\.${method}\\??\\.?\\(`),
      );
    }
  });

  it('finds a call of each callback the inventory says is called', () => {
    const text = sources('src')
      .filter((path) => !path.includes('src/types/'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const [name, point] of entries) {
      if (!point.called) continue;
      const method = name.split('.')[1] as string;
      expect(text, `${name} is in the inventory as called but nothing calls it`).toMatch(
        new RegExp(`(\\.${method}\\??\\.?\\(|${method}\\.call\\(|\\.${method}\\b)`),
      );
    }
  });

  for (const [name, probes] of Object.entries(harness) as [PluginCallback, Probes][]) {
    describe(name, () => {
      it(
        'an oversized value gives the named limit (or, for a throw, a bounded copy)',
        probes.oversized,
      );
      it('a forged engine error is never received as itself', probes.forged);
      it('an undefined hidden in a list is refused with its pointer', probes.hidden);
    });
  }
});
