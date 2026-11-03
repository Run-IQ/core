import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { isReading, isRegistering } from '../../src/engine/pluginPort.js';
import { CROSSING_POINTS } from '../../src/engine/pluginBoundary.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

// Ruling 1 of round 8, completed as ruled in round 9. Every object and function a plugin, a model
// and a DSL provide is a Proxy that records each of the 13 traps the engine could use on it
// (`get`, `has`, `ownKeys`, `getOwnPropertyDescriptor`, `getPrototypeOf`, `setPrototypeOf`,
// `isExtensible`, `preventExtensions`, `defineProperty`, `deleteProperty`, `set`, `apply`,
// `construct`), with whether the engine was inside the port (the reader or a registration). Each
// scenario fails if any access happened outside; the matrix runs a throwing variant of every
// callback, a rejecting variant of the async ones, and a registration that is refused; and the set
// of callbacks the log shows the engine calling must be exactly the inventory's. Any future code
// that touches plugin data without the port fails it.

interface Access {
  readonly where: string;
  readonly trap: string;
  readonly key: string;
  readonly inside: boolean;
}
const log: Access[] = [];
const reached = new Set<string>();
const traps = new Set<string>();
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  log.length = 0;
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  // The assertion of every scenario: nothing outside the port.
  const outside = log.filter((access) => !access.inside);
  expect(outside).toEqual([]);
  expect(unhandled).toEqual([]);
});

const OWNER: Record<string, string> = {
  plugin: 'PPEPlugin',
  model: 'CalculationModel',
  dsl: 'DSLEvaluator',
};

const note = (where: string, trap: string, key?: string | symbol): void => {
  traps.add(trap);
  log.push({
    where,
    trap,
    key: key === undefined ? '' : String(key),
    inside: isReading() || isRegistering(),
  });
  if (trap === 'apply') {
    const parts = where.split('.');
    const [role, callback] = parts;
    if (
      parts.length === 2 &&
      role !== undefined &&
      callback !== undefined &&
      OWNER[role] !== undefined
    ) {
      reached.add(`${OWNER[role]}.${callback}`);
    }
  }
};

function wrap(value: unknown, where: string): unknown {
  // A Date (or a native promise) has internal slots: as a Proxy it would stop being one.
  if (value instanceof Date || value instanceof Promise) return value;
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? hostile(value as object, where)
    : value;
}

/** A Proxy over `target` that records every trap and hands out hostile values in turn. */
function hostile<T extends object>(target: T, where: string): T {
  return new Proxy(target, {
    get(t, key, receiver) {
      note(where, 'get', key);
      return wrap(Reflect.get(t, key, receiver), `${where}.${String(key)}`);
    },
    has(t, key) {
      note(where, 'has', key);
      return Reflect.has(t, key);
    },
    ownKeys(t) {
      note(where, 'ownKeys');
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, key) {
      note(where, 'getOwnPropertyDescriptor', key);
      const descriptor = Reflect.getOwnPropertyDescriptor(t, key);
      // A configurable data property may show another value; a fixed one may not (Proxy invariant).
      if (descriptor !== undefined && 'value' in descriptor && descriptor.configurable === true) {
        return { ...descriptor, value: wrap(descriptor.value, `${where}.${String(key)}`) };
      }
      return descriptor;
    },
    getPrototypeOf(t) {
      note(where, 'getPrototypeOf');
      return Reflect.getPrototypeOf(t);
    },
    setPrototypeOf(t, prototype) {
      note(where, 'setPrototypeOf');
      return Reflect.setPrototypeOf(t, prototype);
    },
    isExtensible(t) {
      note(where, 'isExtensible');
      return Reflect.isExtensible(t);
    },
    preventExtensions(t) {
      note(where, 'preventExtensions');
      return Reflect.preventExtensions(t);
    },
    defineProperty(t, key, descriptor) {
      note(where, 'defineProperty', key);
      return Reflect.defineProperty(t, key, descriptor);
    },
    deleteProperty(t, key) {
      note(where, 'deleteProperty', key);
      return Reflect.deleteProperty(t, key);
    },
    set(t, key, value, receiver) {
      note(where, 'set', key);
      return Reflect.set(t, key, value, receiver);
    },
    apply(t, thisArg, args) {
      note(where, 'apply');
      return wrap(
        Reflect.apply(t as unknown as (...a: unknown[]) => unknown, thisArg, args),
        `${where}()`,
      );
    },
    construct(t, args, newTarget) {
      note(where, 'construct');
      return Reflect.construct(t as unknown as new (...a: unknown[]) => object, args, newTarget);
    },
  });
}

/** An error whose class and fields are the plugin's. */
const boom = (message: string): Error => Object.assign(new RangeError(message), { code: 'E_BOOM' });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Callback =
  | 'onInit'
  | 'beforeEvaluate'
  | 'afterEvaluate'
  | 'onError'
  | 'validateParams'
  | 'calculate'
  | 'dslEvaluate'
  | 'dslListVariables';
type Mode = 'answer' | 'throw' | 'reject';

/**
 * The plugin in every role: hooks, a model, a DSL, `onError`. Everything it is made of is hostile.
 * `modes` makes a callback throw (or, for the async ones, reject) a hostile error.
 */
function fixture(modes: Partial<Record<Callback, Mode>> = {}): {
  plugin: PPEPlugin;
  dsl: DSLEvaluator;
  rules: Rule[];
} {
  const act = <T>(callback: Callback, answer: () => T): T | Promise<never> => {
    const mode = modes[callback] ?? 'answer';
    const error = hostile(boom(`${callback} failed`), `thrown ${callback}`);
    if (mode === 'throw') throw error;
    if (mode === 'reject') return Promise.reject(error);
    return answer();
  };
  const model: CalculationModel = {
    name: 'HOSTILE',
    version: '1.0.0',
    output: { type: 'number', combine: 'sum' },
    validateParams: () =>
      act('validateParams', () => hostile({ valid: true }, 'model.validateParams()')) as never,
    calculate: () =>
      act('calculate', () =>
        hostile({ value: 7, detail: { note: 'x' } }, 'model.calculate()'),
      ) as never,
    listVariables: () => ['/amount'],
    describeParams: () => ({}),
  };
  const dsl: DSLEvaluator = {
    dsl: 'hostiledsl',
    version: '1.0.0',
    evaluate: () => act('dslEvaluate', () => hostile({ yes: true }, 'dsl.evaluate()')) as never,
    listVariables: () =>
      act('dslListVariables', () => hostile(['/amount'], 'dsl.listVariables()')) as never,
  };
  const plugin: PPEPlugin = {
    name: 'hostile-plugin',
    version: '1.2.3',
    onInit: (context: PluginContext) =>
      act('onInit', () => {
        context.modelRegistry.register(hostile(model, 'model') as CalculationModel);
        context.modelRegistry.register(new StubModel('PLAIN', 3));
        return undefined;
      }) as never,
    beforeEvaluate: (input, current) =>
      act('beforeEvaluate', () => {
        const kept = current.map((rule) => plain(rule));
        return hostile(
          {
            input: plain({ ...input, meta: { tenantId: input.meta.tenantId } }),
            rules: kept,
            skipped: [],
            state: { seen: current.length },
          },
          'plugin.beforeEvaluate()',
        );
      }) as never,
    afterEvaluate: () =>
      act('afterEvaluate', () =>
        hostile({ annotations: { audited: true } }, 'plugin.afterEvaluate()'),
      ) as never,
    onError: () => {
      act('onError', () => undefined);
    },
  };
  const rules = [
    makeRule({
      id: 'hostile',
      model: 'HOSTILE',
      condition: { dsl: 'hostiledsl', value: { any: 1 } },
    }),
    makeRule({ id: 'plain', model: 'PLAIN' }),
  ];
  return { plugin, dsl, rules };
}

type Fixture = ReturnType<typeof fixture>;

function engineOf(f: Fixture): PPEEngine {
  return new PPEEngine({
    plugins: [hostile(f.plugin, 'plugin')],
    dsls: [hostile(f.dsl, 'dsl')],
    strict: false,
  });
}

async function outcomeOf(f: Fixture): Promise<unknown> {
  try {
    return await engineOf(f).evaluate(f.rules, makeInput());
  } catch (error) {
    return error;
  }
}

describe('a plugin made only of Proxies, in every role', () => {
  it('is registered and evaluated with no access outside the port', async () => {
    const f = fixture();
    const result = await engineOf(f).evaluate(f.rules, makeInput());
    expect(result.appliedRules.length).toBeGreaterThan(0);
    expect(result.meta).toEqual({ 'hostile-plugin': { audited: true } });
    expect(log.length).toBeGreaterThan(20); // the probe really recorded the engine's accesses
  });

  for (const callback of [
    'beforeEvaluate',
    'afterEvaluate',
    'validateParams',
    'calculate',
  ] as const) {
    it(`fails with ${callback} throwing a hostile error, and the plugin onError is told`, async () => {
      const error = await outcomeOf(fixture({ [callback]: 'throw' }));
      expect(error).toBeInstanceOf(Error);
      // A fault is text: never the object the plugin threw.
      const cause = (error as { cause?: object }).cause;
      expect(cause).toBeDefined();
      expect(Object.getPrototypeOf(cause)).toBe(Object.prototype);
    });
  }

  for (const callback of ['beforeEvaluate', 'afterEvaluate'] as const) {
    it(`fails with ${callback} rejecting a hostile error, held as text`, async () => {
      const error = (await outcomeOf(fixture({ [callback]: 'reject' }))) as PluginHookError;
      expect(error).toBeInstanceOf(PluginHookError);
      expect(Object.getPrototypeOf(error.cause)).toBe(Object.prototype);
      expect(error.cause).toMatchObject({ name: 'RangeError', code: 'E_BOOM' });
    });
  }

  for (const callback of ['dslEvaluate', 'dslListVariables'] as const) {
    it(`survives ${callback} throwing: the rule is excluded or a problem is named`, async () => {
      const f = fixture({ [callback]: 'throw' });
      const result = await engineOf(f).evaluate(f.rules, makeInput());
      if (callback === 'dslEvaluate') {
        expect(result.skippedRules.map((skip) => skip.reason)).toContain('DSL_ERROR');
      } else {
        expect(result.diagnostics.map((d) => d.message).join(' ')).toContain('failed');
      }
    });
  }

  it('has onError throwing a hostile error swallowed, the evaluation own error reaching the caller', async () => {
    const error = await outcomeOf(fixture({ beforeEvaluate: 'throw', onError: 'throw' }));
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ hook: 'beforeEvaluate' });
  });

  it('has an onInit that throws, and one that rejects, fail the construction', () => {
    for (const mode of ['throw', 'reject'] as const) {
      expect(() => engineOf(fixture({ onInit: mode }))).toThrow(PluginHookError);
    }
  });

  it('is refused at registration, naming the field', () => {
    const f = fixture();
    const bad = hostile({ ...f.plugin, version: 'not a version' }, 'bad plugin');
    expect(
      () => new PPEEngine({ plugins: [bad], dsls: [hostile(f.dsl, 'dsl')], strict: false }),
    ).toThrow(/version/);
  });

  it('survives hostile promises where a promise is allowed and refuses them where it is not', async () => {
    const f = fixture();
    const promising: PPEPlugin = {
      ...f.plugin,
      beforeEvaluate: (input, current) =>
        hostile(
          {
            then(resolve: (value: unknown) => void): void {
              resolve({ input, rules: current });
            },
          } as unknown as object,
          'plugin.beforeEvaluate()',
        ) as never,
      afterEvaluate: () =>
        hostile(
          {
            then(resolve: (value: unknown) => void): void {
              resolve({ annotations: { late: true } });
            },
          } as unknown as object,
          'plugin.afterEvaluate()',
        ) as never,
    };
    const engine = new PPEEngine({
      plugins: [hostile(promising, 'plugin')],
      dsls: [hostile(f.dsl, 'dsl')],
      strict: false,
    });
    await engine.evaluate(f.rules, makeInput());

    // A synchronous callback that returns a hostile promise that rejects: a fault, handled; and
    // the second engine's plugin is as hostile as the first.
    const rejecting = hostile(
      {
        name: 'rejecting',
        version: '1.0.0',
        onInit: (context: PluginContext) => {
          context.modelRegistry.register(
            hostile(
              {
                name: 'REJECTS',
                version: '1.0.0',
                validateParams: () => ({ valid: true }),
                calculate: () => Promise.reject(boom('late')),
              } as unknown as CalculationModel,
              'model',
            ),
          );
        },
      } as PPEPlugin,
      'plugin',
    );
    const second = new PPEEngine({ plugins: [rejecting], dsls: [], strict: false });
    const failure = await second
      .evaluate([makeRule({ id: 'r', model: 'REJECTS' })], makeInput())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(failure).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('adopts a promise subclass and a thenable resolving to a rejected promise without the value own then', async () => {
    class Sub extends Promise<unknown> {
      override then(): never {
        throw new Error('the own then of the subclass must not be used');
      }
    }
    const sub = hostile(
      {
        name: 'subclassing',
        version: '1.0.0',
        onInit: (context: PluginContext) => {
          context.modelRegistry.register(
            hostile(
              {
                name: 'SUBBED',
                version: '1.0.0',
                validateParams: () => ({ valid: true }),
                calculate: () => Sub.reject(boom('subclass')),
              } as unknown as CalculationModel,
              'model',
            ),
          );
        },
      } as PPEPlugin,
      'plugin',
    );
    const engine = new PPEEngine({ plugins: [sub], dsls: [], strict: false });
    const failure = await engine
      .evaluate([makeRule({ id: 'r', model: 'SUBBED' })], makeInput())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((failure as Error).message).toContain('returned a promise');
    // A hook whose thenable resolves with a rejected promise: refused, and the promise handled.
    const resolving: PPEPlugin = {
      name: 'resolving',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: (() => ({
        then(resolve: (value: unknown) => void): void {
          resolve(Promise.reject(boom('inner')));
        },
      })) as never,
    };
    const second = new PPEEngine({
      plugins: [hostile(resolving, 'plugin')],
      dsls: [],
      strict: false,
    });
    const refused = await second.evaluate([], makeInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(refused).toBeInstanceOf(PluginHookError);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe('what the log shows', () => {
  it('reaches every callback of the inventory the engine calls, and no other', () => {
    const called = Object.entries(CROSSING_POINTS)
      .filter(([, point]) => point.called)
      .map(([name]) => name)
      .sort();
    // `onError` and `onInit` are reached only by the scenarios above; the set is the log's.
    expect([...reached].sort()).toEqual(called);
  });

  it('has seen the traps an engine uses on plugin data', () => {
    for (const trap of ['get', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'apply']) {
      expect(traps.has(trap), `${trap} in ${[...traps].join(',')}`).toBe(true);
    }
  });
});
