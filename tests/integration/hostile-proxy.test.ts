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
/** The traps the engine itself used (the recorder test's own targets are `recorder`). */
const evaluationTraps = new Set<string>();
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
  if (where !== 'recorder') evaluationTraps.add(trap);
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
  // A Date or a native promise is wrapped too (MC4): as a Proxy it is no longer one, so the engine
  // can only refuse it, and every access it makes is logged.
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
      const answer = Reflect.apply(t as unknown as (...a: unknown[]) => unknown, thisArg, args);
      // The promise an async hook itself returns stays native (as a Proxy it could not be
      // awaited); every promise or Date inside what is returned is wrapped.
      return answer instanceof Promise ? answer : wrap(answer, `${where}()`);
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
    name: 'hostile',
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
        context.modelRegistry.register(hostile(new StubModel('plain', 3), 'model.plain'));
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
      model: 'hostile',
      condition: { dsl: 'hostiledsl', value: { any: 1 } },
    }),
    makeRule({ id: 'plain', model: 'plain' }),
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
                name: 'rejects',
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
      .evaluate([makeRule({ id: 'r', model: 'rejects' })], makeInput())
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
                name: 'subbed',
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
      .evaluate([makeRule({ id: 'r', model: 'subbed' })], makeInput())
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

const ALL_TRAPS = [
  'apply',
  'construct',
  'defineProperty',
  'deleteProperty',
  'get',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'has',
  'isExtensible',
  'ownKeys',
  'preventExtensions',
  'set',
  'setPrototypeOf',
];

describe('MC1, MC6, M2b: the recorder itself', () => {
  it('records each of the 13 traps, so that none can be dropped unnoticed', () => {
    const seen = new Set<string>();
    const run = (operate: (proxy: Record<string, unknown> & (() => unknown)) => void): void => {
      log.length = 0;
      const target = Object.assign(
        function () {
          return undefined;
        },
        { a: 1 },
      ) as unknown as Record<string, unknown> & (() => unknown);
      operate(hostile(target, 'recorder') as never);
      for (const access of log) seen.add(access.trap);
      log.length = 0;
    };
    run((p) => void p['a']);
    run((p) => void ('a' in p));
    run((p) => void Reflect.ownKeys(p));
    run((p) => void Object.getOwnPropertyDescriptor(p, 'a'));
    run((p) => void Object.getPrototypeOf(p));
    run((p) => void Object.setPrototypeOf(p, null));
    run((p) => void Object.isExtensible(p));
    run((p) => void Object.preventExtensions(p));
    run((p) => void Object.defineProperty(p, 'b', { value: 1, configurable: true }));
    run((p) => void delete p['a']);
    run((p) => {
      p['c'] = 1;
    });
    run((p) => void p());
    run((p) => void new (p as unknown as new () => object)());
    expect([...seen].sort()).toEqual(ALL_TRAPS);
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
    // MC6: the exact set of traps the engine used on plugin data (the writing ones never are),
    // never a superset check.
    expect([...evaluationTraps].sort()).toEqual([
      'apply',
      'get',
      'getOwnPropertyDescriptor',
      'getPrototypeOf',
      'isExtensible',
      'ownKeys',
    ]);
  });
});

/** Walks a result: no Date, promise, function or symbol came out of a plugin (MC4). */
function assertPlain(value: unknown, path: string, seen = new Set<unknown>()): void {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`${path} is a ${typeof value}`);
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(value instanceof Date, `${path} is a Date`).toBe(false);
  expect(value instanceof Promise, `${path} is a promise`).toBe(false);
  expect(typeof (value as { then?: unknown }).then, `${path} is a thenable`).not.toBe('function');
  for (const key of Reflect.ownKeys(value)) {
    expect(typeof key, `${path} has a symbol key`).toBe('string');
    assertPlain((value as Record<string, unknown>)[key as string], `${path}.${String(key)}`, seen);
  }
}

const engineWith = (plugin: PPEPlugin): PPEEngine =>
  new PPEEngine({ plugins: [hostile(plugin, 'plugin')], dsls: [], strict: false });

describe('MC4: a hostile native promise or Date, wrapped, comes out nowhere', () => {
  const modelReturning = (output: () => unknown): PPEPlugin => ({
    name: 'natives',
    version: '1.0.0',
    onInit: (context: PluginContext) => {
      context.modelRegistry.register(
        hostile(
          {
            name: 'natives',
            version: '1.0.0',
            validateParams: () => ({ valid: true }),
            calculate: output,
          } as unknown as CalculationModel,
          'model',
        ),
      );
    },
  });

  for (const [label, make] of [
    ['a Date', () => hostile(new Date(0), 'model.date')],
    ['a native promise', () => hostile(Promise.resolve(1), 'model.promise')],
  ] as const) {
    it(`${label} in a model output excludes the rule and none of it reaches the result`, async () => {
      const result = await engineWith(modelReturning(() => ({ value: make() }))).evaluate(
        [makeRule({ id: 'n', model: 'natives' })],
        makeInput(),
      );
      expect(result.appliedRules).toEqual([]);
      expect(result.skippedRules.map((skip) => skip.rule.id)).toEqual(['n']);
      // (the engine's own `timestamp` is the one Date a result holds)
      assertPlain({ ...result, timestamp: undefined }, 'result');
    });

    it(`${label} in what a hook returns fails the evaluation`, async () => {
      const plugin: PPEPlugin = {
        name: 'hooked',
        version: '1.0.0',
        onInit: () => undefined,
        beforeEvaluate: (input, current) =>
          ({
            input: { ...input, data: { held: make() } },
            rules: current,
          }) as never,
      };
      const error = await engineWith(plugin)
        .evaluate([], makeInput())
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(PluginHookError);
    });
  }
});

describe('MC2: a hostile nested engine, and values with hostile conversions', () => {
  it('a plugin that runs a whole nested engine of its own, hostile inside, and throws its error gives text', async () => {
    // The nested engine's plugin and model are hostile too; its model throws a hostile error, and
    // the outer hook throws the nested engine's own error.
    const innerModel = {
      name: 'inner',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (): never => {
        throw hostile(boom('inner model failed'), 'thrown inner');
      },
    } as unknown as CalculationModel;
    const innerPlugin: PPEPlugin = {
      name: 'inner-plugin',
      version: '1.0.0',
      onInit: (context: PluginContext) => {
        context.modelRegistry.register(hostile(innerModel, 'inner.model'));
      },
    };
    const inner = new PPEEngine({
      plugins: [hostile(innerPlugin, 'inner.plugin')],
      dsls: [],
      strict: false,
    });
    const plugin: PPEPlugin = {
      name: 'nesting',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: async () => {
        await inner.evaluate([makeRule({ id: 'a', model: 'inner' })], makeInput());
        return undefined as never;
      },
    };
    const error = (await engineWith(plugin)
      .evaluate([], makeInput())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )) as PluginHookError;
    expect(error).toBeInstanceOf(PluginHookError);
    expect(Object.getPrototypeOf(error.cause)).toBe(Object.prototype);
    expect(error.cause).toMatchObject({ name: 'UnexpectedEngineError' });
    expect(JSON.stringify(error.cause)).toContain('inner model failed');
  });

  it('values with toJSON, valueOf, Symbol.toPrimitive and an iterator are refused and never called', async () => {
    const calls: string[] = [];
    const trap = (): Record<string | symbol, unknown> => ({
      toJSON: () => {
        calls.push('toJSON');
        return 1;
      },
      valueOf: () => {
        calls.push('valueOf');
        return 1;
      },
      toString: () => {
        calls.push('toString');
        return 'x';
      },
      [Symbol.toPrimitive]: () => {
        calls.push('toPrimitive');
        return 1;
      },
      [Symbol.iterator]: function* () {
        calls.push('iterator');
        yield 1;
      },
    });
    const kinds: Array<[string, () => unknown]> = [
      ['a value', () => ({ value: trap() })],
      ['a detail', () => ({ value: 7, detail: { held: trap() } })],
      ['the whole output', () => trap()],
    ];
    for (const [label, output] of kinds) {
      calls.length = 0;
      const plugin: PPEPlugin = {
        name: 'converting',
        version: '1.0.0',
        onInit: (context: PluginContext) => {
          context.modelRegistry.register(
            hostile(
              {
                name: 'converting',
                version: '1.0.0',
                validateParams: () => ({ valid: true }),
                calculate: output,
              } as unknown as CalculationModel,
              'model',
            ),
          );
        },
      };
      const result: unknown = await engineWith(plugin)
        .evaluate([makeRule({ id: 'c', model: 'converting' })], makeInput())
        .then(
          (value) => value,
          (caught: unknown) => caught,
        );
      expect(calls, `${label}: a conversion of the plugin was run`).toEqual([]);
      if (result instanceof Error) expect(result.message).not.toContain('toJSON');
      else expect((result as { appliedRules: unknown }).appliedRules, label).toEqual([]);
    }
  });

  it('a DSL whose listVariables answer is an iterator is refused and not iterated', async () => {
    const calls: string[] = [];
    const dsl: DSLEvaluator = {
      dsl: 'iterating',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: () =>
        ({
          [Symbol.iterator]: function* () {
            calls.push('iterator');
            yield '/a';
          },
        }) as never,
    };
    const engine = new PPEEngine({
      plugins: [
        {
          name: 'host',
          version: '1.0.0',
          onInit: (context: PluginContext) =>
            context.modelRegistry.register(hostile(new StubModel('plain', 3), 'model.plain')),
        },
      ],
      dsls: [hostile(dsl, 'dsl')],
      strict: false,
    });
    const result = await engine.evaluate(
      [makeRule({ id: 'i', model: 'plain', condition: { dsl: 'iterating', value: {} } })],
      makeInput(),
    );
    expect(calls).toEqual([]);
    expect(result.diagnostics.map((d) => d.message).join(' ')).toContain('failed');
  });
});

describe('AH3: objects with hostile conversions, thrown or returned in every role', () => {
  const calls: string[] = [];
  const trap = (): Record<string | symbol, unknown> =>
    hostile(
      {
        toJSON: () => (calls.push('toJSON'), 1),
        valueOf: () => (calls.push('valueOf'), 1),
        toString: () => (calls.push('toString'), 'x'),
        [Symbol.toPrimitive]: () => (calls.push('toPrimitive'), 1),
        [Symbol.iterator]: function* () {
          calls.push('iterator');
          yield 1;
        },
        get then() {
          calls.push('then');
          return undefined;
        },
      } as Record<string | symbol, unknown>,
      'trap',
    );
  const plainModel = (): CalculationModel =>
    hostile(new StubModel('plain', 3), 'model.plain') as unknown as CalculationModel;
  const host = (extra: Partial<PPEPlugin> = {}): PPEPlugin => ({
    name: 'host',
    version: '1.0.0',
    onInit: (context: PluginContext) => context.modelRegistry.register(plainModel()),
    ...extra,
  });
  const modelPlugin = (parts: Partial<CalculationModel>): PPEPlugin => ({
    name: 'roles',
    version: '1.0.0',
    onInit: (context: PluginContext) =>
      context.modelRegistry.register(
        hostile(
          {
            name: 'roles',
            version: '1.0.0',
            validateParams: () => ({ valid: true }),
            calculate: () => 1,
            ...parts,
          } as unknown as CalculationModel,
          'model.roles',
        ),
      ),
  });
  const dslEngine = (parts: Partial<DSLEvaluator>): PPEEngine =>
    new PPEEngine({
      plugins: [hostile(host(), 'plugin')],
      dsls: [
        hostile({ dsl: 'roles', version: '1.0.0', evaluate: () => true, ...parts }, 'dsl') as never,
      ],
      strict: false,
    });
  const outcome = async (run: () => Promise<unknown>): Promise<unknown> =>
    run().then(
      (value) => value,
      (caught: unknown) => caught,
    );
  const rolesRule = makeRule({ id: 'r', model: 'roles' });
  const dslRule = makeRule({
    id: 'd',
    model: 'plain',
    condition: { dsl: 'roles', value: {} },
  });
  const throwing = (): never => {
    throw trap();
  };

  const roles: Record<string, () => Promise<unknown>> = {
    'calculate throws': () =>
      outcome(() =>
        engineWith(modelPlugin({ calculate: throwing })).evaluate([rolesRule], makeInput()),
      ),
    'calculate returns': () =>
      outcome(() =>
        engineWith(modelPlugin({ calculate: () => trap() as never })).evaluate(
          [rolesRule],
          makeInput(),
        ),
      ),
    'validateParams throws': () =>
      outcome(() =>
        engineWith(modelPlugin({ validateParams: throwing })).evaluate([rolesRule], makeInput()),
      ),
    'validateParams returns': () =>
      outcome(() =>
        engineWith(modelPlugin({ validateParams: () => trap() as never })).evaluate(
          [rolesRule],
          makeInput(),
        ),
      ),
    'validateParams errors item': () =>
      outcome(() =>
        engineWith(
          modelPlugin({ validateParams: () => ({ valid: false, errors: [trap() as never] }) }),
        ).evaluate([rolesRule], makeInput()),
      ),
    'DSL evaluate throws': () =>
      outcome(() => dslEngine({ evaluate: throwing }).evaluate([dslRule], makeInput())),
    'DSL evaluate returns': () =>
      outcome(() =>
        dslEngine({ evaluate: () => trap() as never }).evaluate([dslRule], makeInput()),
      ),
    'DSL listVariables item': () =>
      outcome(() =>
        dslEngine({ listVariables: () => [trap() as never] }).evaluate([dslRule], makeInput()),
      ),
    'DSL listVariables throws': () =>
      outcome(() => dslEngine({ listVariables: throwing }).evaluate([dslRule], makeInput())),
    'beforeEvaluate throws': () =>
      outcome(() =>
        engineWith(host({ beforeEvaluate: throwing as never })).evaluate([], makeInput()),
      ),
    'beforeEvaluate data': () =>
      outcome(() =>
        engineWith(
          host({
            beforeEvaluate: (input, rules) =>
              ({ input: { ...input, data: { held: trap() } }, rules }) as never,
          }),
        ).evaluate([], makeInput()),
      ),
    'beforeEvaluate state': () =>
      outcome(() =>
        engineWith(
          host({ beforeEvaluate: (input, rules) => ({ input, rules, state: trap() as never }) }),
        ).evaluate([], makeInput()),
      ),
    'afterEvaluate annotations': () =>
      outcome(() =>
        engineWith(
          host({ afterEvaluate: () => ({ annotations: { held: trap() as never } }) }),
        ).evaluate([], makeInput()),
      ),
    'afterEvaluate returns': () =>
      outcome(() =>
        engineWith(host({ afterEvaluate: () => trap() as never })).evaluate([], makeInput()),
      ),
    'afterEvaluate throws': () =>
      outcome(() =>
        engineWith(host({ afterEvaluate: throwing as never })).evaluate([], makeInput()),
      ),
    'onError throws': () =>
      outcome(() =>
        engineWith(
          host({
            beforeEvaluate: () => {
              throw new Error('real');
            },
            onError: throwing,
          }),
        ).evaluate([], makeInput()),
      ),
    'onInit throws': async () => {
      try {
        engineWith(host({ onInit: throwing }));
      } catch (error) {
        return error;
      }
      return undefined;
    },
  };

  for (const [role, run] of Object.entries(roles)) {
    it(`${role}: no conversion of the object is ever run, and nothing hostile comes out`, async () => {
      calls.length = 0;
      const result = await run();
      // `then` is read by the thenable check of the port, and nothing else is.
      expect(
        calls.filter((call) => call !== 'then'),
        role,
      ).toEqual([]);
      if (result instanceof Error) {
        expect(result.message.length).toBeLessThan(1400);
        expect(Object.isFrozen(result)).toBe(true);
      } else if (result !== undefined) {
        assertPlain({ ...(result as Record<string, unknown>), timestamp: undefined }, 'result');
      }
    });
  }
});
