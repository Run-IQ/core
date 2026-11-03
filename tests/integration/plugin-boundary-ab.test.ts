import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { PluginFaultError } from '../../src/engine/pluginPort.js';
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
        name: 'evil',
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
        [makeRule({ id: 'e', model: 'evil' })],
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

describe('AB4: promises are adopted through the captured intrinsics', () => {
  it('a rejected promise subclass with its own then, returned by calculate, leaves no unhandled rejection', async () => {
    class Sub extends Promise<unknown> {
      override then(): never {
        throw new Error('own then');
      }
    }
    const model: CalculationModel = {
      name: 'sub',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => Sub.reject(new Error('late')) as never,
    };
    const error = await failure(build([regModel(model)]), [makeRule({ id: 's', model: 'sub' })]);
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
      name: 'prx',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => proxy as never,
    };
    const error = await failure(build([regModel(model)]), [makeRule({ id: 'p', model: 'prx' })]);
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
          model: 'flat',
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
      name: 'evil',
      version: '1.0.0',
      validateParams: () => ({ valid: false, errors: ['x\uDC00'] }),
      calculate: () => 1,
    };
    const result = await build([regModel(evil)]).evaluate(
      [makeRule({ id: 'e', model: 'evil' })],
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
  it('B81: a model name is lower case, with an optional scope and single separators', () => {
    for (const name of ['', 'a..b', 'a b', '@x', 'a/b', 'FLAT_RATE', 'Flat', '@/x', '@A/x']) {
      expect(() => build([regModel({ ...FLAT, name })]), name).toThrow(/model/);
    }
    for (const name of ['flat_rate', 'flat.rate-2', '@run-iq/exception']) {
      expect(() => build([regModel({ ...FLAT, name })]), name).not.toThrow();
    }
  });
});
