import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { isReading, isRegistering } from '../../src/engine/pluginPort.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

// Ruling 1 of round 8: completeness is checked by a machine. Every object and function a plugin,
// a model and a DSL provide is a Proxy that records each `get`, `has`, `ownKeys`,
// `getOwnPropertyDescriptor`, `getPrototypeOf`, `apply`, `construct` (and each write) the engine
// performs on it, with whether the engine was inside the port (the reader or a registration).
// The test fails if any access happened outside. Any future code that touches plugin data without
// the port fails it.

interface Access {
  readonly where: string;
  readonly trap: string;
  readonly key: string;
  readonly inside: boolean;
}
const log: Access[] = [];
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
});

const note = (where: string, trap: string, key?: string | symbol): void => {
  log.push({
    where,
    trap,
    key: key === undefined ? '' : String(key),
    inside: isReading() || isRegistering(),
  });
};

function wrap(value: unknown, where: string): unknown {
  // A Date (or a native promise) has internal slots: as a Proxy it would stop being one.
  if (value instanceof Date || value instanceof Promise) return value;
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? hostile(value as object, where)
    : value;
}

/** A Proxy over `target` that records every access and hands out hostile values in turn. */
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
      // The value is the target's own: a Proxy invariant forbids another one for a fixed property.
      return descriptor;
    },
    getPrototypeOf(t) {
      note(where, 'getPrototypeOf');
      return Reflect.getPrototypeOf(t);
    },
    set(t, key, value, receiver) {
      note(where, 'set', key);
      return Reflect.set(t, key, value, receiver);
    },
    defineProperty(t, key, descriptor) {
      note(where, 'defineProperty', key);
      return Reflect.defineProperty(t, key, descriptor);
    },
    deleteProperty(t, key) {
      note(where, 'deleteProperty', key);
      return Reflect.deleteProperty(t, key);
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

interface Roles {
  readonly throwing: boolean;
}

/**
 * The plugin in every role: hooks, a model, a DSL, `onError`. Everything it is made of is hostile.
 * With `throwing`, each callback throws a hostile error instead of answering.
 */
function fixture({ throwing }: Roles): {
  plugin: PPEPlugin;
  dsl: DSLEvaluator;
  rules: Rule[];
} {
  const fail = (what: string): never => {
    throw hostile(boom(`${what} failed`), `thrown ${what}`);
  };
  const model: CalculationModel = {
    name: 'HOSTILE',
    version: '1.0.0',
    output: { type: 'number', combine: 'sum' },
    validateParams: () =>
      throwing
        ? fail('validateParams')
        : (hostile({ valid: true }, 'validateParams()') as { valid: boolean }),
    calculate: () =>
      throwing
        ? fail('calculate')
        : (hostile({ value: 7, detail: { note: 'x' } }, 'calculate()') as never),
    listVariables: () => ['/amount'],
    describeParams: () => ({}),
  };
  const dsl: DSLEvaluator = {
    dsl: 'hostiledsl',
    version: '1.0.0',
    evaluate: () =>
      throwing ? fail('dsl evaluate') : (hostile({ yes: true }, 'dsl evaluate()') as never),
    listVariables: () =>
      throwing ? fail('dsl listVariables') : (hostile(['/amount'], 'dsl listVariables()') as never),
  };
  const plugin: PPEPlugin = {
    name: 'hostile-plugin',
    version: '1.2.3',
    onInit(context: PluginContext): void {
      context.modelRegistry.register(hostile(model, 'model') as CalculationModel);
      context.modelRegistry.register(new StubModel('PLAIN', 3));
    },
    beforeEvaluate: (input, current) => {
      if (throwing) return fail('beforeEvaluate');
      const kept = current.map((rule) => plain(rule));
      return hostile(
        {
          input: plain({ ...input, meta: { tenantId: input.meta.tenantId } }),
          rules: kept,
          skipped: [],
          state: { seen: current.length },
        },
        'beforeEvaluate()',
      ) as never;
    },
    afterEvaluate: (_input, result) => {
      if (throwing) return fail('afterEvaluate');
      return hostile({ ...result, meta: { audited: true } }, 'afterEvaluate()') as never;
    },
    onError: () => {
      if (throwing) fail('onError');
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

function outside(): Access[] {
  return log.filter((access) => !access.inside);
}

describe('a plugin made only of Proxies, in every role', () => {
  it('is registered and evaluated with no access outside the port', async () => {
    const { plugin, dsl, rules } = fixture({ throwing: false });
    const engine = new PPEEngine({
      plugins: [hostile(plugin, 'plugin')],
      dsls: [hostile(dsl, 'dsl')],
      strict: false,
    });
    const result = await engine.evaluate(rules, makeInput());
    expect(result.appliedRules.length).toBeGreaterThan(0);
    expect(log.length).toBeGreaterThan(20); // the probe really recorded the engine's accesses
    expect(outside()).toEqual([]);
  });

  it('fails with every callback throwing, with no access outside the port', async () => {
    const { plugin, dsl, rules } = fixture({ throwing: true });
    const engine = new PPEEngine({
      plugins: [hostile(plugin, 'plugin')],
      dsls: [hostile(dsl, 'dsl')],
      strict: false,
    });
    const error = await engine.evaluate(rules, makeInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeDefined();
    expect(outside()).toEqual([]);
  });

  it('is refused at registration, naming the field, with no access outside the port', () => {
    const { plugin, dsl } = fixture({ throwing: false });
    const bad = hostile({ ...plugin, version: 'not a version' }, 'bad plugin');
    expect(
      () => new PPEEngine({ plugins: [bad], dsls: [hostile(dsl, 'dsl')], strict: false }),
    ).toThrow(/version/);
    expect(outside()).toEqual([]);
  });

  it('has its onInit failure fail the construction', () => {
    const { plugin, dsl } = fixture({ throwing: false });
    const failing: PPEPlugin = {
      ...plugin,
      onInit: () => {
        throw hostile(boom('init failed'), 'thrown onInit');
      },
    };
    expect(
      () =>
        new PPEEngine({
          plugins: [hostile(failing, 'plugin')],
          dsls: [hostile(dsl, 'dsl')],
          strict: false,
        }),
    ).toThrow(/init failed/);
    expect(outside()).toEqual([]);
  });

  it('survives hostile promises where a promise is allowed and refuses them where it is not', async () => {
    const { plugin, dsl, rules } = fixture({ throwing: false });
    const promising: PPEPlugin = {
      ...plugin,
      beforeEvaluate: (input, current) =>
        hostile(
          {
            then(resolve: (value: unknown) => void): void {
              resolve({ input, rules: current });
            },
          } as unknown as object,
          'hook thenable',
        ) as never,
      afterEvaluate: (_input, result) =>
        hostile(
          {
            then(resolve: (value: unknown) => void): void {
              resolve(result);
            },
          } as unknown as object,
          'after thenable',
        ) as never,
    };
    const engine = new PPEEngine({
      plugins: [hostile(promising, 'plugin')],
      dsls: [hostile(dsl, 'dsl')],
      strict: false,
    });
    await engine.evaluate(rules, makeInput());
    expect(outside()).toEqual([]);

    // A synchronous callback that returns a hostile promise that rejects: a fault, handled.
    log.length = 0;
    const rejecting = {
      ...plugin,
      name: 'rejecting',
      onInit: (context: PluginContext) => {
        context.modelRegistry.register(
          hostile(
            {
              name: 'REJECTS',
              version: '1.0.0',
              validateParams: () => ({ valid: true }),
              calculate: () => Promise.reject(boom('late')),
            } as unknown as CalculationModel,
            'rejecting model',
          ),
        );
      },
    } as PPEPlugin;
    const second = new PPEEngine({ plugins: [rejecting], dsls: [], strict: false });
    const failure = await second
      .evaluate([makeRule({ id: 'r', model: 'REJECTS' })], makeInput())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(failure).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
    expect(outside()).toEqual([]);
  });
});
