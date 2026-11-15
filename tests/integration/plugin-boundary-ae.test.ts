import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import type { PPEPlugin } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { EvaluationInput } from '../../src/types/input.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Round 11 of the 9L audit (AE1 to AE9 and the spec rows).

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

import { ValidationError } from '../../src/errors/ValidationError.js';
import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { readsOf } from '../../src/context/reads.js';
import { PluginFaultError } from '../../src/engine/pluginPort.js';

const modelNamed = (name: string, over: Partial<CalculationModel> = {}): CalculationModel => ({
  name,
  version: '1.0.0',
  validateParams: () => ({ valid: true }),
  calculate: () => 1,
  ...over,
});

describe('AE1: a string meta.effectiveDate works in every path', () => {
  const dates = ['2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00+01:00'];
  const withDate = (effectiveDate: string, requestId: string) =>
    makeInput({ requestId, meta: { tenantId: 't', effectiveDate: effectiveDate as never } });

  it.each(dates)('%s: every hook role runs and the record holds a string', async (date) => {
    const saved: Array<{ inputSnapshot: { meta: { effectiveDate?: unknown } } }> = [];
    const adapter = {
      save: async (snapshot: unknown) => {
        saved.push(snapshot as never);
        return 'id';
      },
      get: async () => {
        throw new Error('unused');
      },
      exists: async () => false,
    };
    const seen: unknown[] = [];
    const engine = build(
      [
        pluginWith('p', {
          beforeEvaluate: (input, rules) => {
            seen.push(input.meta.effectiveDate);
            return { input, rules };
          },
          afterEvaluate: (input) => {
            seen.push(input.meta.effectiveDate);
            return undefined;
          },
        }),
      ],
      { snapshot: adapter },
    );
    const result = await engine.evaluate([tax()], withDate(date, `ae1-${date}`));
    expect(result.value).toBe(100);
    expect(seen).toHaveLength(2);
    for (const value of seen) expect(typeof value).toBe('string');
    expect(typeof saved[0]?.inputSnapshot.meta.effectiveDate).toBe('string');
  });

  it('onError is called once and the caller gets the original error, not a TypeError', async () => {
    let told = 0;
    const engine = build(
      [
        pluginWith('p', {
          onError: () => {
            told += 1;
          },
        }),
      ],
      { limits: { maxRules: 1 } },
    );
    const error = await failure(
      engine,
      [tax(1, 'a'), tax(1, 'b')],
      withDate('2026-01-01', 'ae1-onerror'),
    );
    expect(told).toBe(1);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRules' });
  });

  it('a hook that fails with a string date is a PluginHookError, never a raw TypeError', async () => {
    const engine = build([
      pluginWith('p', {
        beforeEvaluate: () => {
          throw new Error('boom');
        },
      }),
    ]);
    const error = await failure(engine, [tax()], withDate('2026-01-01', 'ae1-hook'));
    expect(error).toBeInstanceOf(PluginHookError);
  });
});

describe('AE2: the listVariables length is read once', () => {
  it('a Proxy answering 1 then 600 000 is read as one item, in one read of the length', async () => {
    let lengthReads = 0;
    const answer = new Proxy(['/x'], {
      get(target, key, receiver) {
        if (key === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 600_000;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const dsl: DSLEvaluator = {
      dsl: 'l',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: () => answer,
    };
    const rule = makeRule({ id: 'c', model: 'm', condition: { dsl: 'l', value: {} } });
    const reads = readsOf(rule, dsl, undefined);
    expect(lengthReads).toBe(1);
    expect(reads.pointers).toEqual(['/x']);
  });

  it('a list longer than the cap marks the reads unknown, never an evaluation limit', () => {
    const dsl: DSLEvaluator = {
      dsl: 'l',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: () =>
        new Proxy([] as string[], {
          get: (t, k, r) => (k === 'length' ? 10_000_000 : Reflect.get(t, k, r)),
        }),
    };
    const rule = makeRule({ id: 'c', model: 'm', condition: { dsl: 'l', value: {} } });
    const reads = readsOf(rule, dsl, undefined);
    expect(reads.declared).toBe(false);
    expect(reads.problems[0]?.kind).toBe('failed');
  });
});

describe('AE3: a limit passed on a model, DSL or validateParams return names its source', () => {
  const run = async (
    plugins: PPEPlugin[],
    dsls: DSLEvaluator[],
    rules: Rule[],
    limits = { maxHookLeaves: 50 },
  ) => failure(build(plugins, { limits }, dsls), rules);

  it('a model output', async () => {
    const big = modelNamed('big', {
      calculate: () => ({ value: 1, detail: Array.from({ length: 200 }, (_, i) => i) }) as never,
    });
    const error = await run([regModel(big)], [], [makeRule({ id: 'b', model: 'big' })]);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxHookLeaves', source: 'model:big' });
    expect((error as Error).message).toContain('returned by model:big');
  });

  it('a DSL verdict', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'wide',
      version: '1.0.0',
      evaluate: () =>
        Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])) as never,
    };
    const error = await run(
      [],
      [dsl],
      [makeRule({ id: 'c', model: 'm', condition: { dsl: 'wide', value: {} } })],
    );
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ source: 'dsl:wide' });
  });

  it('a validateParams result', async () => {
    const wordy = modelNamed('wordy', {
      validateParams: () => ({ valid: false, errors: ['x'.repeat(100_000)] }),
    });
    const error = await run([regModel(wordy)], [], [makeRule({ id: 'w', model: 'wordy' })]);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ source: 'validateParams:wordy' });
  });
});

describe('AE4: a refused write taints the call even when the plugin catches it', () => {
  const writer =
    (key: 'calculate' | 'validateParams') =>
    (...args: unknown[]): unknown => {
      const target = (key === 'calculate' ? args[2] : args[0]) as Record<string, unknown>;
      try {
        target['rate'] = 0;
      } catch {
        // caught: the plugin carries on
      }
      return key === 'calculate' ? 4 : { valid: true };
    };

  it('calculate: the rule is MODEL_ERROR, not applied', async () => {
    const model = modelNamed('catcher', { calculate: writer('calculate') as never });
    const result = await build([regModel(model)]).evaluate(
      [makeRule({ id: 'c', model: 'catcher', params: { rate: 1 } })],
      makeInput(),
    );
    expect(result.skippedRules[0]).toMatchObject({ reason: 'MODEL_ERROR' });
    expect(result.skippedRules[0]?.detail).toContain('wrote to its input');
    expect(result.appliedRules).toEqual([]);
  });

  it('validateParams of a source rule: the rule is excluded', async () => {
    const model = modelNamed('vcatcher', { validateParams: writer('validateParams') as never });
    const result = await build([regModel(model)]).evaluate(
      [makeRule({ id: 'v', model: 'vcatcher', params: { rate: 1 } })],
      makeInput(),
    );
    expect(result.skippedRules[0]?.reason).toBe('MODEL_ERROR');
    expect(result.appliedRules).toEqual([]);
  });

  it('validateParams of a hook-added rule: a PluginHookError', async () => {
    const model = modelNamed('vcatcher2', { validateParams: writer('validateParams') as never });
    const adder = pluginWith('adder', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [...rules, makeRule({ id: 'added', model: 'vcatcher2', params: { rate: 1 } })],
      }),
    });
    const error = await failure(build([regModel(model), adder]), [tax()]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: 'adder' });
  });

  it('a DSL: DSL_ERROR', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'dcatch',
      version: '1.0.0',
      evaluate: (expression) => {
        try {
          (expression as Record<string, unknown>)['at'] = 1;
        } catch {
          // caught
        }
        return true;
      },
    };
    const result = await build([], {}, [dsl]).evaluate(
      [makeRule({ id: 'd', model: 'm', condition: { dsl: 'dcatch', value: { a: 1 } } })],
      makeInput(),
    );
    expect(result.skippedRules[0]?.reason).toBe('DSL_ERROR');
  });
});

describe('AE5: the errors the caller receives are frozen', () => {
  it('PluginHookError, UnexpectedEngineError and ValidationError', async () => {
    const hook = await failure(build([pluginWith('p', { beforeEvaluate: () => 42 as never })]), [
      tax(),
    ]);
    expect(hook).toBeInstanceOf(PluginHookError);
    expect(Object.isFrozen(hook)).toBe(true);
    expect(Object.isFrozen((hook as PluginHookError).cause)).toBe(true);
    const thrower = modelNamed('thrower', {
      calculate: () => {
        throw new Error('own');
      },
    });
    const unexpected = await failure(build([regModel(thrower)]), [
      makeRule({ id: 't', model: 'thrower' }),
    ]);
    expect(unexpected).toBeInstanceOf(UnexpectedEngineError);
    expect(Object.isFrozen(unexpected)).toBe(true);
    const invalid = await failure(build([]), [tax()], { requestId: 'x', data: {}, meta: {} });
    expect(invalid).toBeInstanceOf(ValidationError);
    expect(Object.isFrozen(invalid)).toBe(true);
    expect(Object.isFrozen((invalid as ValidationError).reasons)).toBe(true);
  });
});

describe('B59, B60, AE9: a failing onError is attached to the original error', () => {
  it('onError throws during a maxRules refusal: the caller gets EngineLimitError with onErrorFailure', async () => {
    const adapter = new InMemorySnapshotAdapter();
    const engine = build(
      [
        pluginWith('noisy', {
          onError: () => {
            throw new Error('onError crash');
          },
        }),
      ],
      { limits: { maxRules: 1 }, snapshot: adapter },
    );
    const error = await failure(engine, [tax(1, 'a'), tax(1, 'b')]);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRules', max: 1, actual: 2 });
    const failures = (error as { onErrorFailures: PluginHookError[] }).onErrorFailures;
    expect(failures).toHaveLength(1);
    expect(Object.isFrozen(failures)).toBe(true);
    const attached = failures[0];
    expect(attached).toBeInstanceOf(PluginHookError);
    expect(attached).toMatchObject({ plugin: 'noisy', hook: 'onError' });
    expect((attached?.cause as { message: string }).message).toBe('onError crash');
    expect((error as Error).cause).toBeUndefined();
    expect(await adapter.exists('test-request-001')).toBe(false);
  });

  it('a promise from onError is attached, not awaited', async () => {
    const engine = build([pluginWith('async', { onError: (async () => undefined) as never })], {
      limits: { maxRules: 1 },
    });
    const error = await failure(engine, [tax(1, 'a'), tax(1, 'b')]);
    const attached = (error as { onErrorFailures: PluginHookError[] }).onErrorFailures[0];
    expect(attached).toMatchObject({ plugin: 'async', hook: 'onError' });
    expect((attached?.cause as { message: string }).message).toContain('returned a promise');
  });

  it('two failing onError hooks: both are kept, in plugin order (K8)', async () => {
    const failing = (name: string, message: string): PPEPlugin =>
      pluginWith(name, {
        onError: () => {
          throw new Error(message);
        },
      });
    const engine = build([failing('first', 'one'), failing('second', 'two')], {
      limits: { maxRules: 1 },
    });
    const error = await failure(engine, [tax(1, 'a'), tax(1, 'b')]);
    const failures = (error as { onErrorFailures: PluginHookError[] }).onErrorFailures;
    expect(failures.map((f) => f.plugin)).toEqual(['first', 'second']);
    expect(failures.map((f) => (f.cause as { message: string }).message)).toEqual(['one', 'two']);
  });

  it('an error nobody failed on has an empty onErrorFailures', async () => {
    const error = await failure(build([], { limits: { maxRules: 1 } }), [tax(1, 'a'), tax(1, 'b')]);
    expect((error as { onErrorFailures: unknown[] }).onErrorFailures).toEqual([]);
  });
});

describe('B83: onInit is synchronous', () => {
  it('an async onInit that resolves fails the construction with hook onInit', () => {
    let error: unknown;
    try {
      build([pluginWith('late', { onInit: (async () => undefined) as never })]);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: 'late', hook: 'onInit' });
  });
});

describe('B6: a hook rules list whose length is not a length', () => {
  it.each(['x', -1, 2 ** 53])('length %j is a PluginHookError', async (length) => {
    const proxy = new Proxy([] as unknown[], {
      get: (t, k, r) => (k === 'length' ? length : Reflect.get(t, k, r)),
    });
    const engine = build([
      pluginWith('p', { beforeEvaluate: (input) => ({ input, rules: proxy as never }) }),
    ]);
    expect(await failure(engine, [])).toBeInstanceOf(PluginHookError);
  });
});

describe('M15, B22: a skip records the engine own rule, never the hook copy', () => {
  it('a skip whose rule is a reordered copy records the ledger rule, in its own key order', async () => {
    const given = tax();
    const engine = build([
      pluginWith('p', {
        beforeEvaluate: (input, rules) => {
          const copy = Object.fromEntries(Object.entries(rules[0] as object).reverse());
          return { input, rules: [], skipped: [{ rule: copy as never, reason: 'PLUGIN' }] };
        },
      }),
    ]);
    const result = await engine.evaluate([given], makeInput());
    const recorded = result.skippedRules[0]?.rule as object;
    expect(Object.keys(recorded)).toEqual(Object.keys(given));
    expect(Object.isFrozen(recorded)).toBe(true);
  });
});

describe("B85: a Proxy that does not bind then is refused, and its rejection stays the plugin's", () => {
  it('is refused as returned a promise', async () => {
    const target = Promise.reject(new Error('late'));
    const unbound = new Proxy(target, {});
    const model = modelNamed('unbound', { calculate: () => unbound as never });
    const error = await failure(build([regModel(model)]), [
      makeRule({ id: 'u', model: 'unbound' }),
    ]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as Error).message).toContain('returned a promise');
    // The stated limit: the engine cannot reach the promise the Proxy wraps, so its rejection is
    // the plugin's own to handle. It is reported once, and handled here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    target.catch(() => undefined);
    unhandled = [];
  });
});

describe('B33, MC9: a stolen engine error and a forged internal fault, at every entry', () => {
  const stolen = async (): Promise<unknown> => {
    const inner = build([], { limits: { maxRules: 1 } });
    return failure(inner, [tax(1, 'a'), tax(1, 'b')], makeInput({ requestId: 'stolen' }));
  };
  const forgedFault = (): unknown => {
    const forged = new PluginFaultError('forged');
    Object.defineProperty(forged, 'message', { get: () => 'm'.repeat(5_000_000) });
    return forged;
  };
  const sources: Array<[string, () => Promise<unknown>]> = [
    ['a stolen engine error', stolen],
    ['a forged internal fault', async () => forgedFault()],
  ];
  const roles: Record<string, (thrown: unknown) => Promise<unknown>> = {
    calculate: async (thrown) =>
      failure(
        build([
          regModel(
            modelNamed('c', {
              calculate: () => {
                throw thrown;
              },
            }),
          ),
        ]),
        [makeRule({ id: 'c', model: 'c' })],
      ),
    validateParams: async (thrown) =>
      failure(
        build([
          regModel(
            modelNamed('v', {
              validateParams: () => {
                throw thrown;
              },
            }),
          ),
        ]),
        [makeRule({ id: 'v', model: 'v' })],
      ),
    beforeEvaluate: async (thrown) =>
      failure(
        build([
          pluginWith('p', {
            beforeEvaluate: () => {
              throw thrown;
            },
          }),
        ]),
        [tax()],
      ),
    afterEvaluate: async (thrown) =>
      failure(
        build([
          pluginWith('p', {
            afterEvaluate: () => {
              throw thrown;
            },
          }),
        ]),
        [tax()],
      ),
    onInit: async (thrown) => {
      try {
        build([
          pluginWith('p', {
            onInit: () => {
              throw thrown;
            },
          }),
        ]);
      } catch (error) {
        return error;
      }
      return undefined;
    },
  };

  // The two entries the table above does not drive: `onError` (its throw is attached to the
  // caller's error as text) and the `evaluate` of a DSL (its throw is the rule's DSL_ERROR detail).
  for (const [what, make] of sources) {
    it(`${what} thrown by onError is attached as text, never itself`, async () => {
      const thrown = await make();
      const error = (await failure(
        build([
          pluginWith('p', {
            beforeEvaluate: () => {
              throw new Error('real');
            },
            onError: () => {
              throw thrown;
            },
          }),
        ]),
        [tax()],
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(error.onErrorFailures).toHaveLength(1);
      const failure1 = error.onErrorFailures[0] as PluginHookError;
      expect(failure1).not.toBe(thrown);
      expect(failure1.message.length).toBeLessThan(1300);
      expect(failure1.cause).not.toBe(thrown);
      expect(failure1.cause).not.toBeInstanceOf(EngineLimitError);
    });

    it(`${what} thrown by a DSL evaluate is a bounded text in the skip, never itself`, async () => {
      const thrown = await make();
      const dsl: DSLEvaluator = {
        dsl: 'thrower',
        version: '1.0.0',
        evaluate: () => {
          throw thrown;
        },
      };
      const result = await build([regModel(modelNamed('one', {}))], {}, [dsl]).evaluate(
        [makeRule({ id: 'c', model: 'one', condition: { dsl: 'thrower', value: {} } })],
        makeInput(),
      );
      expect(result.skippedRules[0]?.reason).toBe('DSL_ERROR');
      expect((result.skippedRules[0]?.detail ?? '').length).toBeLessThan(1300);
    });
  }

  for (const [what, make] of sources) {
    for (const [role, run] of Object.entries(roles)) {
      it(`${what} thrown by ${role} is text, never itself`, async () => {
        const thrown = await make();
        const error = await run(thrown);
        expect(error).toBeDefined();
        expect(error).not.toBe(thrown);
        expect((error as Error).message.length).toBeLessThan(1300);
        const cause = (error as { cause?: unknown }).cause;
        if (typeof cause === 'object' && cause !== null) {
          expect(cause).not.toBe(thrown);
          expect(cause).not.toBeInstanceOf(EngineLimitError);
        }
      });
    }
  }
});

describe('AG2: a write made while the engine reads the returned value, and caught, taints the call', () => {
  it('W3: a getter of the model output that writes and catches: MODEL_ERROR', async () => {
    const model = modelNamed('getterwriter', {
      calculate: (_input: unknown, _rule: unknown, params: unknown) =>
        ({
          get value(): number {
            try {
              (params as Record<string, unknown>)['rate'] = 9;
            } catch {
              // caught
            }
            return 4;
          },
        }) as never,
    });
    const result = await build([regModel(model)]).evaluate(
      [makeRule({ id: 'g', model: 'getterwriter', params: { rate: 1 } })],
      makeInput(),
    );
    expect(result.skippedRules[0]).toMatchObject({ reason: 'MODEL_ERROR' });
    expect(result.skippedRules[0]?.detail).toContain('wrote to its input');
    expect(result.appliedRules).toEqual([]);
  });

  it('W3b: a tainted call has its returned value never read (the getter is not run)', async () => {
    let reads = 0;
    const model = modelNamed('tainted', {
      calculate: (_input: unknown, _rule: unknown, params: unknown) => {
        try {
          (params as Record<string, unknown>)['rate'] = 9;
        } catch {
          // caught
        }
        return {
          get value(): number {
            reads += 1;
            return 4;
          },
        } as never;
      },
    });
    const result = await build([regModel(model)]).evaluate(
      [makeRule({ id: 't', model: 'tainted', params: { rate: 1 } })],
      makeInput(),
    );
    expect(result.skippedRules[0]).toMatchObject({ reason: 'MODEL_ERROR' });
    expect(reads).toBe(0);
  });

  it('W2: a trap of the DSL verdict that writes and catches: DSL_ERROR', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'trapwriter',
      version: '1.0.0',
      evaluate: (expression) =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              try {
                (expression as Record<string, unknown>)['at'] = 1;
              } catch {
                // caught
              }
              return Object.prototype;
            },
          },
        ) as never,
    };
    const result = await build([], {}, [dsl]).evaluate(
      [makeRule({ id: 'd', model: 'm', condition: { dsl: 'trapwriter', value: { a: 1 } } })],
      makeInput(),
    );
    expect(result.skippedRules[0]?.reason).toBe('DSL_ERROR');
    expect(result.appliedRules).toEqual([]);
  });

  it('W5: a listVariables that writes, catches and answers: the reads are unknown', () => {
    const dsl: DSLEvaluator = {
      dsl: 'lvwriter',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: (expression) => {
        try {
          (expression as Record<string, unknown>)['at'] = 1;
        } catch {
          // caught
        }
        return ['/amount'];
      },
    };
    const rule = makeRule({ id: 'c', model: 'm', condition: { dsl: 'lvwriter', value: { a: 1 } } });
    const reads = readsOf(rule, dsl, undefined);
    expect(reads.declared).toBe(false);
    expect(reads.problems[0]?.kind).toBe('failed');
    expect(reads.problems[0]?.message).toContain('wrote to its input');
  });

  it('K4b: validateParams that writes, catches and answers with a verdict: MODEL_ERROR, not INVALID_PARAMS', async () => {
    const model = modelNamed('slowcatcher', {
      validateParams: ((params: Record<string, unknown>) => {
        try {
          params['rate'] = 0;
        } catch {
          // caught
        }
        return { valid: false, errors: ['rate is bad'] };
      }) as never,
    });
    const result = await build([regModel(model)]).evaluate(
      [makeRule({ id: 's', model: 'slowcatcher', params: { rate: 1 } })],
      makeInput(),
    );
    expect(result.skippedRules[0]?.reason).toBe('MODEL_ERROR');
    expect(result.skippedRules[0]?.detail).toContain('wrote to its input');
  });
});

describe('K13: a listVariables length that is not a length marks the reads unknown', () => {
  it.each([[Number.NaN], [-1], [1.5], ['3'], [2 ** 53], [undefined]])('length %j', (length) => {
    const answer = new Proxy([] as string[], {
      get: (t, k, r) => (k === 'length' ? length : Reflect.get(t, k, r)),
    });
    const dsl: DSLEvaluator = {
      dsl: 'badlength',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: () => answer,
    };
    const rule = makeRule({ id: 'c', model: 'm', condition: { dsl: 'badlength', value: {} } });
    const reads = readsOf(rule, dsl, undefined);
    expect(reads.declared).toBe(false);
    expect(reads.problems[0]?.kind).toBe('failed');
    expect(reads.problems[0]?.message).toContain('invalid length');
  });
});

describe('K9, K17: the source of a listVariables limit, and an attributed limit is frozen', () => {
  it('a listVariables answer past maxHookLeaves names its dsl, and the error is frozen', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'lv',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: () => Array.from({ length: 10 }, (_, i) => `/${'a'.repeat(300)}${i}`),
    };
    const error = await failure(build([], { limits: { maxHookLeaves: 20 } }, [dsl]), [
      makeRule({ id: 'c', model: 'm', condition: { dsl: 'lv', value: {} } }),
    ]);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxHookLeaves', source: 'dsl:lv' });
    expect(Object.isFrozen(error)).toBe(true);
  });
});
