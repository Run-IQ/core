import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { EngineLimitError, raiseLimit } from '../../src/errors/EngineLimitError.js';
import { BoundaryError, PluginFaultError, refusal } from '../../src/engine/pluginPort.js';
import { inCall } from '../../src/engine/trust.js';
import { hasLoneSurrogate } from '../../src/utils/weight.js';
import type { PPEPlugin } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import type { EvaluationInput } from '../../src/types/input.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Round 9 of the 9L audit (AB1 to AB7 and the rulings): trust nothing a constructor can make.

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
const isTextOf = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  Object.getPrototypeOf(cause) === Object.prototype &&
  Object.isFrozen(cause);

describe('AB1: the fault brand is not made by a constructor, and no field of an error is trusted', () => {
  const huge = (): Record<string, unknown> => ({
    name: 'Evil',
    get message(): string {
      return 'm'.repeat(5_000_000);
    },
    code: { toString: () => 'plugin code ran' },
  });

  it('a PluginFaultError a plugin builds is a thrown value like any other: reduced to bounded text', async () => {
    for (const where of ['calculate', 'validateParams', 'beforeEvaluate'] as const) {
      const forged = Object.assign(new PluginFaultError('forged'), { fault: huge() });
      const model: CalculationModel = {
        name: 'EVIL',
        version: '1.0.0',
        validateParams: () => {
          if (where === 'validateParams') throw forged;
          return { valid: true };
        },
        calculate: () => {
          if (where === 'calculate') throw forged;
          return 1;
        },
      };
      const hook = pluginWith('hook', {
        beforeEvaluate: (input, current) => {
          if (where === 'beforeEvaluate') throw forged;
          return { input, rules: current };
        },
      });
      const error = (await failure(
        build([regModel(model), hook]),
        [makeRule({ id: 'e', model: 'EVIL' })],
        makeInput({ requestId: `ab1-${where}` }),
      )) as Error & { cause: { name: string; message: string; code?: unknown } };
      expect(error).not.toBe(forged);
      expect(error.message.length).toBeLessThan(1200);
      expect(
        isTextOf(error.cause),
        JSON.stringify([
          where,
          Object.getPrototypeOf(error.cause)?.constructor?.name,
          Object.isFrozen(error.cause),
        ]),
      ).toBe(true);
      expect(error.cause.message.length).toBeLessThan(1100);
      expect(typeof error.cause.name).toBe('string');
      // Not the plugin's `.fault`: the name is the one of the thrown error, a PluginFaultError.
      expect(error.cause.name).toBe('PluginFaultError');
    }
  });

  it('an object that looks like a fault, with a getter read once', async () => {
    let reads = 0;
    const lookalike = {
      name: 'Evil',
      get message(): string {
        reads += 1;
        return 'm'.repeat(5000);
      },
    };
    const hook = pluginWith('hook', {
      beforeEvaluate: () => {
        throw lookalike;
      },
    });
    const error = (await failure(build([hook]), [])) as PluginHookError;
    expect(reads).toBe(1);
    expect(error.message.length).toBeLessThan(1200);
  });

  it('nothing reachable from a plugin can build a trusted fault: the registries it is given expose no snapshot', () => {
    let context: unknown;
    build([pluginWith('grab', { onInit: (c) => void (context = c) })]);
    const api = (context as { modelRegistry: Record<string, unknown> }).modelRegistry;
    expect(Object.keys(api).sort()).toEqual(['get', 'getAll', 'has', 'register']);
    expect('snapshot' in api).toBe(false);
    expect(Object.isFrozen(api)).toBe(true);
    const dsl = (context as { dslRegistry: Record<string, unknown> }).dslRegistry;
    expect(Object.keys(dsl).sort()).toEqual(['get', 'getAll', 'has', 'register']);
  });
});

describe('AB2: an engine class, a limit or a refusal is trusted only if the engine raised it in this call', () => {
  it('a BoundaryError a plugin got from onError and throws from a getter is a plugin fault', async () => {
    let stolen: (new (message: string) => Error) | undefined;
    const engine = build([
      pluginWith('p', {
        beforeEvaluate: ((_input: unknown, current: unknown) => {
          const calls = (engine as unknown as { calls?: number }).calls ?? 0;
          (engine as unknown as { calls?: number }).calls = calls + 1;
          if (calls === 0) return 42; // a malformed result: the engine refuses it with a BoundaryError
          return {
            input: _input,
            rules: current,
            get skipped(): never {
              throw new (stolen as new (message: string) => Error)(
                'the engine refused this, honestly',
              );
            },
          };
        }) as never,
        onError: (told) => {
          const cause = (told as { cause?: object }).cause;
          if (cause !== undefined) stolen = Object.getPrototypeOf(cause).constructor;
        },
      }),
    ]);
    const first = await failure(engine, [], makeInput({ requestId: 'first' }));
    expect(first).toBeInstanceOf(PluginHookError);
    expect(stolen).toBeDefined();
    const second = (await failure(
      engine,
      [],
      makeInput({ requestId: 'second' }),
    )) as PluginHookError;
    expect(second).toBeInstanceOf(PluginHookError);
    // A plugin throw, shown as one: text, not the class that was stolen.
    expect(isTextOf(second.cause)).toBe(true);
  });

  it('an EngineLimitError raised in another call, thrown from a getter, is text, not a limit that was hit', async () => {
    const real = inCall(() => raiseLimit('maxRules', 1, 2));
    expect(real).toBeInstanceOf(EngineLimitError);
    real.message = 'x'.repeat(2_000_000);
    for (const field of ['skipped', 'state'] as const) {
      const hook = pluginWith('hook', {
        beforeEvaluate: (input, current) => {
          const result: Record<string, unknown> = { input, rules: current };
          Object.defineProperty(result, field, {
            enumerable: true,
            get() {
              throw real;
            },
          });
          return result as never;
        },
      });
      const error = (await failure(
        build([hook]),
        [],
        makeInput({ requestId: `ab2-${field}` }),
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(isTextOf(error.cause)).toBe(true);
      expect((error.cause as { limit?: unknown }).limit).toBeUndefined();
      expect(error.message.length).toBeLessThan(1200);
    }
  });

  it('the same for the other classes the engine raises itself, built outside the call', async () => {
    const outside = [
      refusal('the engine refused this, honestly'),
      new BoundaryError('built outside'),
      inCall(() => refusal('raised in another call')),
    ];
    for (const [index, fake] of outside.entries()) {
      const hook = pluginWith('hook', {
        beforeEvaluate: (input, current) => ({
          input,
          rules: current,
          get state(): never {
            throw fake;
          },
        }),
      });
      const error = (await failure(
        build([hook]),
        [],
        makeInput({ requestId: `ab2-class-${index}` }),
      )) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(isTextOf(error.cause), `forgery ${index}`).toBe(true);
    }
  });

  it('what onError is handed is engine data, and a class taken from it does not confer trust', async () => {
    let told: unknown;
    const bad = pluginWith('bad', {
      beforeEvaluate: (() => 42) as never,
      onError: (error) => {
        told = error;
      },
    });
    await failure(build([bad]), []);
    expect(Object.isFrozen(told)).toBe(true);
    expect(told).toBeInstanceOf(PluginHookError);
  });
});

describe('AB4: promises are adopted through the captured intrinsics', () => {
  it('a rejected promise subclass with its own then, returned by calculate, leaves no unhandled rejection', async () => {
    class Sub extends Promise<unknown> {
      override then(): never {
        throw new Error('own then');
      }
    }
    const model: CalculationModel = {
      name: 'SUB',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => Sub.reject(new Error('late')) as never,
    };
    const error = await failure(build([regModel(model)]), [makeRule({ id: 's', model: 'SUB' })]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as Error).message).toContain('returned a promise');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });

  it('a Proxy over a rejected promise, returned by calculate, leaves no unhandled rejection', async () => {
    const target = Promise.reject(new Error('late'));
    const proxy = new Proxy(target, {
      get(t, key) {
        const value = Reflect.get(t, key, t) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(t)
          : value;
      },
    });
    const model: CalculationModel = {
      name: 'PRX',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => proxy as never,
    };
    const error = await failure(build([regModel(model)]), [makeRule({ id: 'p', model: 'PRX' })]);
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect((error as Error).message).toContain('returned a promise');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });

  it('a hook thenable that resolves with a rejected promise is refused and the promise handled', async () => {
    const hook = pluginWith('hook', {
      beforeEvaluate: (() => ({
        then(resolve: (value: unknown) => void): void {
          resolve(Promise.reject(new Error('inner')));
        },
      })) as never,
    });
    const error = await failure(build([hook]), []);
    expect(error).toBeInstanceOf(PluginHookError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });

  it('a hook that rejects is a fault held as text, not the error it rejected with', async () => {
    const rejected = Object.assign(new RangeError('late'), { code: 'E_LATE' });
    const hook = pluginWith('hook', { beforeEvaluate: () => Promise.reject(rejected) });
    const error = (await failure(build([hook]), [])) as PluginHookError;
    expect(error.cause).not.toBe(rejected);
    expect(isTextOf(error.cause)).toBe(true);
    expect(error.cause).toMatchObject({ name: 'RangeError', message: 'late', code: 'E_LATE' });
  });
});

describe('AB6: the text the record holds is well-formed', () => {
  it('a DSL error that the clip would cut in the middle of a pair is cut before the pair', async () => {
    const dsl: DSLEvaluator = {
      dsl: 'pairs',
      version: '1.0.0',
      evaluate: () => {
        throw new Error(`${'a'.repeat(1023)}\u{1F600}${'b'.repeat(10)}`);
      },
    };
    const result = await build([], {}, [dsl]).evaluate(
      [
        makeRule({
          id: 'p',
          model: 'FLAT',
          params: { rate: 1 },
          condition: { dsl: 'pairs', value: {} },
        }),
      ],
      makeInput(),
    );
    const detail = result.skippedRules[0]?.detail ?? '';
    expect(hasLoneSurrogate(detail)).toBe(false);
    expect(detail).toContain('[clipped]');
  });

  it('a name cut at 128 characters is well-formed', async () => {
    const hook = pluginWith('hook', {
      beforeEvaluate: () => {
        throw Object.assign(new Error('m'), { name: `${'a'.repeat(127)}\u{1F600}` });
      },
    });
    const cause = ((await failure(build([hook]), [])) as PluginHookError).cause as { name: string };
    expect(hasLoneSurrogate(cause.name)).toBe(false);
    expect(cause.name.length).toBeLessThanOrEqual(128 + '... [clipped]'.length);
  });

  it('a lone surrogate is refused where plugins hand text to the record, with its pointer', async () => {
    const lone = 'x\uD83D';
    const skip = pluginWith('skip', {
      beforeEvaluate: (input, current) => ({
        input,
        rules: [],
        skipped: current.map((rule) => ({ rule, reason: 'PLUGIN' as const, detail: lone })),
      }),
    });
    const skipped = (await failure(build([skip]), [tax()])) as PluginHookError;
    expect(skipped).toBeInstanceOf(PluginHookError);
    expect((skipped.cause as Error).message).toContain('lone surrogate');
    const annotating = pluginWith('annotating', {
      afterEvaluate: () => ({ annotations: { text: lone } }),
    });
    const annotated = (await failure(
      build([annotating]),
      [],
      makeInput({ requestId: 'annotated' }),
    )) as PluginHookError;
    expect(annotated).toBeInstanceOf(PluginHookError);
    expect((annotated.cause as Error).message).toContain('/text');
    const stateful = pluginWith('stateful', {
      beforeEvaluate: (input, current) => ({ input, rules: current, state: { [lone]: 1 } }),
    });
    const stated = (await failure(
      build([stateful]),
      [],
      makeInput({ requestId: 'stated' }),
    )) as PluginHookError;
    expect(stated).toBeInstanceOf(PluginHookError);
  });

  it('a validateParams error with a lone surrogate makes the answer malformed', async () => {
    const evil: CalculationModel = {
      name: 'EVIL',
      version: '1.0.0',
      validateParams: () => ({ valid: false, errors: ['x\uDC00'] }),
      calculate: () => 1,
    };
    const result = await build([regModel(evil)]).evaluate(
      [makeRule({ id: 'e', model: 'EVIL' })],
      makeInput(),
    );
    expect(result.skippedRules[0]?.reason).toBe('MODEL_ERROR');
    expect(result.skippedRules[0]?.detail).toContain('lone surrogate');
  });
});

describe('AB7: the shape of a name and of a version', () => {
  const refuses = (plugin: PPEPlugin, what: RegExp): void => {
    expect(() => build([plugin])).toThrow(what);
  };
  it('a plugin name is lower case words joined by single . _ or -', () => {
    for (const name of ['A', '..', 'a..b', 'a/b', '@scope/x', '@', '@@@', 'then!', 'a b']) {
      refuses({ ...pluginWith('p', {}), name } as PPEPlugin, /name/);
    }
    for (const name of ['then', 'constructor', 'tostring', 'a.b-c_d']) {
      expect(() => build([{ ...pluginWith('p', {}), name } as PPEPlugin])).not.toThrow();
    }
  });
  it('a version is SemVer 2.0.0', () => {
    for (const version of [
      '01.02.03',
      '1',
      '1.0',
      '1.0.0+..',
      '1.0.0-+-',
      '1'.repeat(21),
      '1.0.0-',
    ]) {
      refuses({ ...pluginWith('p', {}), version } as PPEPlugin, /version/);
    }
    for (const version of ['0.0.0', '1.2.3-alpha.1', '1.2.3+20260101', '10.20.30-rc.1+build.5']) {
      expect(() => build([{ ...pluginWith('p', {}), version } as PPEPlugin])).not.toThrow();
    }
  });
  it('a model name keeps the case a rule pack uses, with single separators, and the reserved name', () => {
    for (const name of ['', 'a..b', 'a b', '@x', 'a/b']) {
      expect(() => build([regModel({ ...FLAT, name })])).toThrow(/model/);
    }
    for (const name of ['FLAT_RATE', 'Flat.Rate-2', '@run-iq/exception']) {
      expect(() => build([regModel({ ...FLAT, name })]), name).not.toThrow();
    }
  });
});
