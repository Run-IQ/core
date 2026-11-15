import { describe, it, expect } from 'vitest';
import * as core from '../../src/index.js';
import * as errors from '../../src/errors/index.js';
import { isEngineError } from '../../src/errors/engineError.js';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { copyCallerValue } from '../../src/engine/callerCopy.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

// The structural ruling of round 15: the caller's side is one crossing point, as the plugin's is.
// Every argument goes through `copyCallerValue` before anything else reads it; the engine's own
// errors are told by identity, completed (frozen, last step of the leaf constructor).

const TRAPS = [
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
] as const;

/** A Proxy that records each of the 13 traps, over `target`. */
function recording<T extends object>(target: T, log: string[]): T {
  const handler: Record<string, unknown> = {};
  for (const trap of TRAPS) {
    handler[trap] = (...args: unknown[]) => {
      log.push(trap);
      return (Reflect as unknown as Record<string, (...a: unknown[]) => unknown>)[trap]?.(...args);
    };
  }
  return new Proxy(target, handler as ProxyHandler<T>);
}

const host = {
  name: 'host',
  version: '1.0.0',
  onInit: (context: { modelRegistry: { register(m: StubModel): void } }) =>
    context.modelRegistry.register(new StubModel('tax', 10)),
} as never;

const outcome = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};
const rejection = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => undefined,
    (error: unknown) => error,
  );

/** Valid constructor arguments of each exported error class. */
const VALID: Record<string, unknown[]> = {
  PPEError: ['m', 'C'],
  RuleConflictError: [['a', 'b'], 1],
  ModelNotFoundError: ['m'],
  DSLNotFoundError: ['d'],
  SnapshotFailureError: [new Error('x'), 'save'],
  DSLTimeoutError: ['d', 5],
  DSLEvaluationError: ['d', new Error('x')],
  PipelineTimeoutError: [5],
  ValidationError: ['bad', ['a']],
  DuplicateRequestError: ['r'],
  EngineLimitError: ['maxRules', 1, 2, '/rules', 'model:m'],
  PluginHookError: ['p', 'beforeEvaluate', new Error('x')],
  FrozenViewWriteError: ['k'],
  ExceptionPrecedenceError: ['a', 'b', 'x', 'y'],
  OutputNotFiniteError: ['o', ['a@1']],
  DecimalPrecisionError: ['o', 1000],
  InvalidModelError: ['m', ['i']],
  HookTimeoutError: ['p', 'afterEvaluate', 5],
  UnexpectedEngineError: [new Error('x')],
  EngineConfigError: ['/strict', 'must be true or false'],
  ChecksumMismatchError: ['a@1', '/rules/0'],
  CallbackError: ['onSnapshotError', new Error('x')],
};
type Ctor = new (...args: unknown[]) => Error;
const classes = Object.entries(errors) as Array<[string, Ctor]>;

describe('AJ1: identity is registered at the end, by the leaf class, and cannot be forged', () => {
  it('has valid arguments for every exported error class', () => {
    expect(Object.keys(VALID).sort()).toEqual(classes.map(([name]) => name).sort());
  });

  for (const [name, Cls] of classes) {
    it(`${name}: a real one is the engine's, frozen; a forged one and a subclass's are not`, () => {
      const real = new Cls(...(VALID[name] as unknown[]));
      expect(isEngineError(real)).toBe(true);
      expect(Object.isFrozen(real)).toBe(true);
      // The base constructor run with this class as new.target: the leaf constructor never runs.
      // (for PPEError itself the forgery IS a real PPEError: new.target is the class)
      if (Cls !== errors.PPEError) {
        const forged = Reflect.construct(errors.PPEError, ['forged', 'X'], Cls) as Error;
        expect(isEngineError(forged), 'forged by Reflect.construct').toBe(false);
      }
      // A subclass, built through the leaf constructor: not the engine's either.
      class Mine extends Cls {}
      const sub = new Mine(...(VALID[name] as unknown[]));
      expect(isEngineError(sub), 'a subclass').toBe(false);
    });
  }

  const forgedValidation = (): Error =>
    Reflect.construct(errors.PPEError, ['forged', 'X'], errors.ValidationError) as Error;
  const forgedConfig = (): Error =>
    Reflect.construct(errors.PPEError, ['forged', 'X'], errors.EngineConfigError) as Error;

  it('a forged error is wrapped by every path that could hand it to the caller', async () => {
    const forgery = forgedConfig();
    // options, limits, timeout, inputSeed: Proxies are refused before any trap can throw it
    for (const [key, value] of [
      [
        null,
        new Proxy(
          { plugins: [], dsls: [] },
          {
            ownKeys: () => {
              throw forgery;
            },
          },
        ),
      ],
      [
        'limits',
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw forgery;
            },
          },
        ),
      ],
      [
        'timeout',
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw forgery;
            },
          },
        ),
      ],
      [
        'inputSeed',
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw forgery;
            },
          },
        ),
      ],
    ] as const) {
      const config = key === null ? value : { plugins: [], dsls: [], [key]: value };
      const error = outcome(() => new PPEEngine(config as never));
      expect(error).not.toBe(forgery);
      expect(isEngineError(error), String(key)).toBe(true);
      expect(Object.isFrozen(error)).toBe(true);
    }
    // evaluate options
    const engine = new PPEEngine({ plugins: [host], dsls: [], strict: false });
    const evalError = await rejection(() =>
      engine.evaluate(
        [makeRule({ id: 'tax', model: 'tax' })],
        makeInput(),
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw forgedValidation();
            },
          },
        ) as never,
      ),
    );
    expect(isEngineError(evalError)).toBe(true);
    expect(Object.isFrozen(evalError)).toBe(true);
    expect(evalError).not.toBe(forgery);
    // an exported helper
    const helper = outcome(() =>
      core.hydrateRule(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw forgery;
            },
          },
        ) as never,
      ),
    );
    expect(isEngineError(helper)).toBe(true);
    expect(helper).not.toBe(forgery);
    // an inputSeed.derive answer whose length trap throws it
    const derived = new PPEEngine({
      plugins: [host],
      dsls: [],
      strict: false,
      inputSeed: {
        derive: () =>
          new Proxy(new Uint8Array(32), {
            get: () => {
              throw forgery;
            },
          }),
      },
    });
    const deriveError = await rejection(() =>
      derived.evaluate([makeRule({ id: 'tax', model: 'tax' })], makeInput()),
    );
    expect(isEngineError(deriveError)).toBe(true);
    expect(deriveError).not.toBe(forgery);
    expect(Object.isFrozen(deriveError)).toBe(true);
  });
});

describe('the inventory of caller crossing points, each with a 13-trap Proxy', () => {
  const ok = { plugins: [host], dsls: [] };
  const crossings: Array<[string, (proxy: object) => unknown]> = [
    ['constructor options', (p) => new PPEEngine(p as never)],
    ['limits', (p) => new PPEEngine({ ...ok, limits: p } as never)],
    ['timeout', (p) => new PPEEngine({ ...ok, timeout: p } as never)],
    ['inputSeed', (p) => new PPEEngine({ ...ok, inputSeed: p } as never)],
    ['inputSeed.secret', (p) => new PPEEngine({ ...ok, inputSeed: { secret: p } } as never)],
    ['plugins', (p) => new PPEEngine({ plugins: p, dsls: [] } as never)],
    ['dsls', (p) => new PPEEngine({ plugins: [], dsls: p } as never)],
    ['hydrateRule', (p) => core.hydrateRule(p as never)],
    ['hydrateRules', (p) => core.hydrateRules(p as never)],
    ['resolveLimits', (p) => core.resolveLimits(p as never)],
    ['normalizeMeta', (p) => core.normalizeMeta(p as never)],
    ['canonicalStringify', (p) => core.canonicalStringify(p as never)],
    ['computeRuleChecksum', (p) => core.computeRuleChecksum(p as never)],
  ];
  for (const [name, call] of crossings) {
    it(`${name}: a Proxy is refused as an engine error, and not one trap is run`, () => {
      const log: string[] = [];
      const target = name === 'plugins' || name === 'dsls' || name === 'hydrateRules' ? [] : {};
      const error = outcome(() => call(recording(target, log)));
      expect(isEngineError(error), name).toBe(true);
      expect(Object.isFrozen(error)).toBe(true);
      expect(log, `${name} ran traps`).toEqual([]);
    });
  }

  it('evaluate options: a Proxy is refused, no trap run', async () => {
    const log: string[] = [];
    const engine = new PPEEngine({ plugins: [host], dsls: [], strict: false });
    const error = await rejection(() =>
      engine.evaluate([], makeInput(), recording({}, log) as never),
    );
    expect(isEngineError(error)).toBe(true);
    expect(log).toEqual([]);
  });

  it('the copier itself: the same refusal and the path, for each shape it declines', () => {
    const fails = (value: unknown, path: string, kind: 'record' | 'list' = 'record'): void => {
      const error = outcome(() => copyCallerValue(value, '/x', { kind } as never));
      expect(isEngineError(error)).toBe(true);
      expect((error as { path: string }).path).toBe(path);
    };
    fails(new Map([['a', 1]]), '/x');
    fails(new Set(), '/x');
    fails(new Date(), '/x');
    fails(
      new (class Box {
        a = 1;
      })(),
      '/x',
    );
    fails(Object.defineProperty({}, 'a', { enumerable: true, get: () => 1 }), '/x/a');
    fails(Object.defineProperty({}, 'a', { value: 1, enumerable: false }), '/x/a');
    fails({ [Symbol('s')]: 1 }, '/x/(symbol)');
    fails([1], '/x'); // a list is not a record
    fails(Object.defineProperty([], 0, { get: () => 1, enumerable: true }), '/x/0', 'list');
    fails(Object.assign([1], { extra: 1 }), '/x/extra', 'list');
    fails([, 1], '/x/0', 'list'); // eslint-disable-line no-sparse-arrays
    fails({ a: 1 }, '/x', 'list');
  });
});

describe('AJ2, AJ3: no instanceof, no length of the caller', () => {
  it('a secret that is a Proxy is refused with no trap and no conversion of what it throws', () => {
    const conversions: string[] = [];
    class Foreign extends errors.ValidationError {}
    const trapObject = {
      toString: () => (conversions.push('toString'), 'x'),
    };
    const secret = new Proxy(new Uint8Array(32), {
      getPrototypeOf() {
        throw new Foreign('x', [trapObject as never]);
      },
    });
    const error = outcome(
      () => new PPEEngine({ plugins: [host], dsls: [], inputSeed: { secret } } as never),
    ) as errors.EngineConfigError;
    expect(isEngineError(error)).toBe(true);
    expect(error.path).toBe('/inputSeed');
    expect(conversions).toEqual([]);
  });

  it('a Uint8Array subclass that lies about its length: the size checked is the size kept', () => {
    class Lying extends Uint8Array {
      override get length(): number {
        return 64;
      }
    }
    const error = outcome(
      () =>
        new PPEEngine({
          plugins: [host],
          dsls: [],
          inputSeed: { secret: new Lying(0) },
        } as never),
    ) as errors.EngineConfigError;
    expect(error).toBeInstanceOf(errors.EngineConfigError);
    expect(error.reason).toContain('at least 32 bytes');
  });

  it('a derive answer that lies about its length is refused, and its getter never runs', async () => {
    let reads = 0;
    class Lying extends Uint8Array {
      override get length(): number {
        reads += 1;
        return 32;
      }
    }
    const engine = new PPEEngine({
      plugins: [host],
      dsls: [],
      strict: false,
      inputSeed: { derive: () => new Lying(0) },
    });
    const error = (await rejection(() =>
      engine.evaluate([makeRule({ id: 'tax', model: 'tax' })], makeInput()),
    )) as errors.ValidationError;
    expect(error).toBeInstanceOf(errors.ValidationError);
    expect(error.reasons).toEqual(['inputSeed.derive must return 32 bytes']);
    expect(reads).toBe(0);
  });

  it("a foreign EngineConfigError subclass is never taken for the engine's own", () => {
    class Foreign extends errors.EngineConfigError {}
    const thrown = new Foreign('/x', 'y');
    const own = outcome(
      () =>
        new PPEEngine({
          plugins: [host],
          dsls: [],
          limits: Object.defineProperty({}, 'maxRules', {
            enumerable: true,
            get: () => {
              throw thrown;
            },
          }),
        } as never),
    ) as errors.EngineConfigError;
    expect(isEngineError(own)).toBe(true);
    expect(own).not.toBe(thrown);
    expect(own.path).toBe('/limits/maxRules');
  });
});

describe('AJ4: the exported classes and methods', () => {
  const bads: unknown[][] = [
    [],
    [null],
    [5],
    [{}],
    [Symbol('s')],
    [null, null],
    [5, 5, 5],
    ['x', null],
    ['x', 5],
    [() => 1],
    [
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('trap');
          },
        },
      ),
    ],
  ];
  for (const [name, Cls] of classes) {
    it(`${name}: a bad argument is a frozen engine error, never a raw one`, () => {
      for (const args of bads) {
        let built: Error | undefined;
        const error = outcome(() => {
          built = new Cls(...args);
        });
        if (error !== undefined) {
          expect(isEngineError(error), `${name}(${String(args.length)} args)`).toBe(true);
          expect(Object.isFrozen(error)).toBe(true);
        } else {
          expect(Object.isFrozen(built)).toBe(true);
        }
      }
    });
  }

  it('evaluate and the runtime-public methods, called on something else, are named errors', async () => {
    for (const self of [null, undefined, {}, 5]) {
      const error = await rejection(() =>
        (PPEEngine.prototype.evaluate as (...args: unknown[]) => Promise<unknown>).call(
          self,
          [],
          makeInput(),
        ),
      );
      expect(isEngineError(error)).toBe(true);
      expect(error).toBeInstanceOf(errors.ValidationError);
      for (const method of ['assertRecordRoom', 'acceptInput', 'copySourceRules']) {
        const raw = outcome(() =>
          (PPEEngine.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[
            method
          ]?.call(self, {}),
        );
        expect(isEngineError(raw), method).toBe(true);
      }
    }
  });

  it('the reasons of a ValidationError are bounded: 20 000 unknown limits', () => {
    const limits: Record<string, number> = {};
    for (let index = 0; index < 20_000; index += 1) limits[`k${index}`] = 1;
    const error = outcome(() => core.resolveLimits(limits as never)) as errors.ValidationError;
    expect(error).toBeInstanceOf(errors.ValidationError);
    expect(error.reasons).toHaveLength(errors.ValidationError.length === 0 ? 51 : 51);
    expect(error.reasons[50]).toBe('... and 19950 more');
    expect(error.reasons.join('').length).toBeLessThan(2000);
  });
});

describe('AJ5: the text of a failure is read by descriptor: no accessor runs', () => {
  const engineWith = (thrown: unknown): PPEEngine =>
    new PPEEngine({
      plugins: [host],
      dsls: [],
      strict: false,
      inputSeed: {
        derive: () => {
          throw thrown;
        },
      },
    });
  const failure = (thrown: unknown): Promise<unknown> =>
    rejection(() =>
      engineWith(thrown).evaluate([makeRule({ id: 'tax', model: 'tax' })], makeInput()),
    );

  it('an own accessor, an inherited accessor and a Proxy `get` trap run nothing', async () => {
    let runs = 0;
    const own = {
      get message(): string {
        runs += 1;
        return 'from getter';
      },
      get name(): string {
        runs += 1;
        return 'Getter';
      },
    };
    const inherited = Object.create({
      get message(): string {
        runs += 1;
        return 'inherited';
      },
    }) as object;
    const proxy = new Proxy(
      {},
      {
        get() {
          runs += 1;
          return 'trap';
        },
      },
    );
    for (const thrown of [own, inherited, proxy]) {
      const error = (await failure(thrown)) as errors.CallbackError;
      expect(error).toBeInstanceOf(errors.CallbackError);
      expect(error.message).not.toContain('from getter');
      expect(error.message).not.toContain('inherited');
    }
    expect(runs).toBe(0);
  });

  it('the data properties of a native error are still read (name, message, code)', async () => {
    const error = (await failure(
      Object.assign(new RangeError('boom'), { code: 'E_BOOM' }),
    )) as errors.CallbackError;
    expect(error.cause).toEqual({ name: 'RangeError', message: 'boom', code: 'E_BOOM' });
  });
});

describe('AJ6: exotic objects and lists are refused, with their path', () => {
  const refused = (config: Record<string, unknown>, path: string): void => {
    const error = outcome(() => new PPEEngine({ plugins: [], dsls: [], ...config } as never));
    expect(error, JSON.stringify(Object.keys(config))).toBeInstanceOf(errors.EngineConfigError);
    expect((error as errors.EngineConfigError).path).toBe(path);
  };

  it('a Map, a Set or a Date for timeout, limits or inputSeed', () => {
    for (const exotic of [new Map([['pipeline', 5]]), new Set(), new Date()]) {
      refused({ timeout: exotic }, '/timeout');
      refused({ limits: exotic }, '/limits');
      refused({ inputSeed: exotic }, '/inputSeed');
    }
  });

  it('a list with an accessor element, an extra key, a hole', () => {
    refused(
      { plugins: Object.defineProperty([], 0, { get: () => host, enumerable: true }) },
      '/plugins/0',
    );
    refused({ plugins: Object.assign([host], { extra: 1 }) }, '/plugins/extra');
    refused({ plugins: [, host] }, '/plugins/0'); // eslint-disable-line no-sparse-arrays
    refused({ dsls: new Proxy([], {}) }, '/dsls');
    refused({ dsls: { length: 0 } }, '/dsls');
  });

  it('a class instance as the options', () => {
    class Options {
      plugins = [];
      dsls = [];
    }
    const error = outcome(() => new PPEEngine(new Options() as never));
    expect(error).toBeInstanceOf(errors.EngineConfigError);
    expect((error as errors.EngineConfigError).path).toBe('/');
  });
});
