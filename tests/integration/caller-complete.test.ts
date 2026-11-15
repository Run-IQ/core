import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import * as core from '../../src/index.js';
import * as errors from '../../src/errors/index.js';
import { isEngineError } from '../../src/errors/engineError.js';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { copyCallerValue, copyCallerData } from '../../src/engine/callerCopy.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Round 16. The inventory is GENERATED from the package entry, not written by hand: every exported
// function, every parameter of it, every public method of every exported class (and the snapshot
// adapter's methods) is given a Proxy that records the 13 traps, and must refuse it as an engine
// error with ZERO traps run, unless the parameter is a plugin-side value (named, with its reason,
// in PLUGIN_SIDE). A new export that does not copy fails the test: `findViolations` is shown to
// catch a planted one.

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

const host = {
  name: 'host',
  version: '1.0.0',
  onInit: (context: { modelRegistry: { register(m: StubModel): void } }) =>
    context.modelRegistry.register(new StubModel('tax', 10)),
} as never;

/** Plugin-side parameters: read by the plugin port, not by the copier, each with its reason. */
const PLUGIN_SIDE: Record<string, string> = {
  'readsOf/1': 'the DSL is a plugin object, read by the port',
  'readsOf/2': 'the model is a plugin object, read by the port',
  'ModelRegistry.register/0': 'a model is a plugin object, read by the port',
  'DSLRegistry.register/0': 'an evaluator is a plugin object, read by the port',
};
/** Exports that are not callable with data, with the reason. */
const NOT_DATA: Record<string, string> = {
  PPEEngine: 'its constructor and methods are enumerated below',
  VERSION: 'a string',
  DEFAULT_LIMITS: 'a frozen constant',
  MAX_LISTED_POINTERS: 'a number',
};

type Callable = (...args: unknown[]) => unknown;

/** Every (name, position, call) the package entry offers, generated from the namespace. */
type Entry = { id: string; call: (proxy: object, filler: unknown) => unknown };
/** What the other positions are given: whatever type they want, one of these is it. */
const FILLERS: unknown[] = [undefined, {}, 'x', [], 0];

function inventory(namespace: Record<string, unknown>): Entry[] {
  const out: Entry[] = [];
  for (const [name, value] of Object.entries(namespace)) {
    if (typeof value !== 'function' || name in NOT_DATA) continue;
    const isClass = /^class\s/.test(Function.prototype.toString.call(value));
    if (name.endsWith('Error') || name === 'PPEError') continue; // constructors: tested apart
    if (isClass) {
      for (const method of Object.getOwnPropertyNames((value as { prototype: object }).prototype)) {
        const fn = (value as { prototype: Record<string, unknown> }).prototype[method];
        if (method === 'constructor' || typeof fn !== 'function') continue;
        const arity = (fn as Callable).length;
        for (let position = 0; position < arity; position += 1) {
          const id = `${name}.${method}/${position}`;
          out.push({
            id,
            call: (proxy, filler) => {
              const instance = new (value as new () => Record<string, Callable>)();
              const args: unknown[] = Array(arity).fill(filler);
              args[position] = proxy;
              return instance[method]?.(...args);
            },
          });
        }
      }
      continue;
    }
    const arity = (value as Callable).length;
    for (let position = 0; position < arity; position += 1) {
      out.push({
        id: `${name}/${position}`,
        call: (proxy, filler) => {
          const args: unknown[] = Array(arity).fill(filler);
          args[position] = proxy;
          return (value as Callable)(...args);
        },
      });
    }
  }
  return out;
}

/**
 * The parameters that accepted a recording Proxy (or ran a trap): a violation of the ruling. The
 * other positions are given each filler in turn, so that a parameter hidden behind an earlier
 * refusal is reached once the earlier ones are valid.
 */
function findViolations(namespace: Record<string, unknown>): string[] {
  const violations: string[] = [];
  for (const { id, call } of inventory(namespace)) {
    if (id in PLUGIN_SIDE) continue;
    for (const filler of FILLERS) {
      const log: string[] = [];
      const error = outcome(() => call(recording({}, log), filler));
      if (!isEngineError(error) || log.length > 0) {
        violations.push(id);
        break;
      }
    }
  }
  return violations;
}

describe('the generated inventory of caller crossing points', () => {
  it('every parameter of every export is copied before it is read: no violation', () => {
    expect(findViolations(core as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("is generated from the namespace: it lists the helpers and the registries' methods", () => {
    const ids = inventory(core as unknown as Record<string, unknown>).map((entry) => entry.id);
    for (const expected of [
      'hydrateRule/0',
      'hashParams/0',
      'buildContext/2',
      'readsOf/0',
      'formatPointer/0',
      'ModelRegistry.register/0',
      'ModelRegistry.get/0',
      'DSLRegistry.get/0',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('a planted export that does not copy is caught', () => {
    const planted = { ...core, plantedHelper: (value: unknown) => value } as unknown as Record<
      string,
      unknown
    >;
    expect(findViolations(planted)).toContain('plantedHelper/0');
  });

  it('a planted export that copies only some of its parameters is caught', () => {
    const planted = {
      ...core,
      plantedPair: (first: unknown, second: unknown) =>
        core.hashParams(first as never) + String(second),
    } as unknown as Record<string, unknown>;
    expect(findViolations(planted)).toContain('plantedPair/1');
  });

  it('PPEEngine: the constructor options, and evaluate rules, input and options', async () => {
    const log: string[] = [];
    const engine = new PPEEngine({ plugins: [host], dsls: [], strict: false });
    const rules = [makeRule({ id: 'tax', model: 'tax' })];
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['rules', () => engine.evaluate(recording([], log) as never, makeInput())],
      ['a rule item', () => engine.evaluate([recording({}, log)] as never, makeInput())],
      ['input', () => engine.evaluate(rules, recording({}, log) as never)],
      [
        'input.data',
        () => engine.evaluate(rules, { ...makeInput(), data: recording({}, log) } as never),
      ],
      [
        'input.meta',
        () => engine.evaluate(rules, { ...makeInput(), meta: recording({}, log) } as never),
      ],
      [
        'input.data member',
        () =>
          engine.evaluate(rules, { ...makeInput(), data: { nested: recording({}, log) } } as never),
      ],
      ['options', () => engine.evaluate(rules, makeInput(), recording({}, log) as never)],
    ];
    for (const [label, run] of cases) {
      log.length = 0;
      const error = await rejection(run);
      expect(isEngineError(error), label).toBe(true);
      expect(Object.isFrozen(error)).toBe(true);
      expect(log, `${label} ran traps`).toEqual([]);
    }
  });

  it('PPEEngine: a getter, an extra key, a subclass, a class instance, a non-enumerable item', async () => {
    const engine = new PPEEngine({ plugins: [host], dsls: [], strict: false });
    const rule = makeRule({ id: 'tax', model: 'tax' });
    let runs = 0;
    const getter = (): never => {
      runs += 1;
      return undefined as never;
    };
    class Rules extends Array {}
    class Input {
      requestId = 'r';
      data = {};
      meta = { tenantId: 't' };
    }
    const accessorId = Object.defineProperty({ ...rule }, 'id', { enumerable: true, get: getter });
    const accessorRequest = Object.defineProperty({ ...makeInput() }, 'requestId', {
      enumerable: true,
      get: getter,
    });
    const accessorData = Object.defineProperty({ ...makeInput() }, 'data', {
      enumerable: true,
      get: getter,
    });
    const hidden = [rule];
    Object.defineProperty(hidden, 0, { value: rule, enumerable: false });
    const bad: Array<[string, unknown, unknown]> = [
      [
        'an accessor element',
        Object.defineProperty([], 0, { get: getter, enumerable: true }),
        makeInput(),
      ],
      ['an extra key', Object.assign([rule], { extra: 1 }), makeInput()],
      ['an Array subclass', Rules.from([rule]), makeInput()],
      ['a non-enumerable item', hidden, makeInput()],
      ['an accessor field of a rule', [accessorId], makeInput()],
      ['a class instance as input', [rule], new Input()],
      ['an accessor requestId', [rule], accessorRequest],
      ['an accessor data', [rule], accessorData],
    ];
    for (const [label, rules, input] of bad) {
      const error = await rejection(() => engine.evaluate(rules as never, input as never));
      expect(error, label).toBeDefined();
      expect(isEngineError(error), label).toBe(true);
    }
    expect(runs).toBe(0);
  });

  it('readsOf: a rule that converts its id is refused and no conversion runs', () => {
    let conversions = 0;
    const rule = {
      id: { toString: () => (conversions++, 'x') },
      version: 1,
      model: 'm',
      params: {},
    };
    const error = outcome(() => core.readsOf(rule as never, undefined, undefined));
    expect(isEngineError(error)).toBe(true);
    expect(conversions).toBe(0);
  });

  it('the snapshot adapter: a Proxy and an accessor are refused, the captured function is the one called', async () => {
    const log: string[] = [];
    const proxied = recording(new InMemorySnapshotAdapter(), log);
    const config = { plugins: [host], dsls: [], strict: false };
    const proxyError = outcome(() => new PPEEngine({ ...config, snapshot: proxied } as never));
    expect(proxyError).toBeInstanceOf(errors.EngineConfigError);
    expect((proxyError as errors.EngineConfigError).path).toBe('/snapshot');
    expect(log).toEqual([]);
    const throwing = Object.defineProperty(new InMemorySnapshotAdapter(), 'exists', {
      get() {
        throw new Error('getter ran');
      },
    });
    const accessorError = outcome(() => new PPEEngine({ ...config, snapshot: throwing } as never));
    expect((accessorError as errors.EngineConfigError).path).toBe('/snapshot/exists');
    expect((accessorError as errors.EngineConfigError).reason).toContain('accessor');
    // The function checked is the function called: replacing it later changes nothing.
    const adapter = new InMemorySnapshotAdapter();
    const engine = new PPEEngine({ ...config, snapshot: adapter });
    let replaced = 0;
    adapter.exists = (() => (replaced++, Promise.resolve(true))) as never;
    await engine.evaluate([makeRule({ id: 'tax', model: 'tax' })], makeInput());
    expect(replaced).toBe(0);
  });
});

describe("AK7: the copier's own rules", () => {
  const fails = (run: () => unknown): void => {
    expect(isEngineError(outcome(run))).toBe(true);
  };

  it('a non-enumerable list index, an Array subclass and a Proxy list are refused', () => {
    const list = [1];
    Object.defineProperty(list, 0, { value: 1, enumerable: false });
    fails(() => copyCallerValue(list, '/x', { kind: 'list' }));
    class Mine extends Array {}
    fails(() => copyCallerValue(Mine.from([1]), '/x', { kind: 'list' }));
    fails(() => new errors.ValidationError('x', new Proxy(['a'], {})));
  });

  it('depth 257 and a node count past the bound are refused', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 300; level += 1) deep = { next: deep };
    fails(() => copyCallerData(deep, '/x'));
    const wide = new Array(2_000_001).fill(0);
    fails(() => copyCallerData(wide, '/x'));
    // Past the node bound with no single list past the list cap: three lists of 800 000.
    const spread = {
      a: new Array(800_000).fill(0),
      b: new Array(800_000).fill(0),
      c: new Array(800_000).fill(0),
    };
    const refusal = outcome(() => copyCallerData(spread, '/x')) as Error;
    expect(isEngineError(refusal)).toBe(true);
    expect(refusal.message).toContain('is too large');
    const ok = new Array(1000).fill(0);
    expect(() => copyCallerData(ok, '/x')).not.toThrow();
  });

  it('a Date is copied, never handed on, and a Date with own keys is refused', () => {
    const date = new Date(0);
    const copy = copyCallerData(date, '/x') as Date;
    expect(copy).not.toBe(date);
    expect(copy.getTime()).toBe(0);
    fails(() => copyCallerData({ d: Object.assign(new Date(0), { extra: 1 }) }, '/x'));
    const lying = Object.assign(new Date(0), { toISOString: () => 'lie' });
    fails(() => copyCallerData(lying, '/x'));
    fails(() => core.hashParams({ d: Object.assign(new Date(0), { extra: 1 }) } as never));
  });

  it('10 001 plugins and an Array subclass of plugins are refused, with their path', () => {
    const plugins = Array.from({ length: 10_001 }, () => host);
    const error = outcome(() => new PPEEngine({ plugins, dsls: [] } as never));
    expect(error).toBeInstanceOf(errors.EngineConfigError);
    expect((error as errors.EngineConfigError).path).toBe('/plugins');
    class Mine extends Array {}
    expect(
      outcome(() => new PPEEngine({ plugins: Mine.from([host]), dsls: [] } as never)),
    ).toBeInstanceOf(errors.EngineConfigError);
  });

  it('a helper refusal is a ValidationError naming the function, not an EngineConfigError', () => {
    const error = outcome(() => core.hashParams(Symbol('s') as never));
    expect(error).toBeInstanceOf(errors.ValidationError);
    expect((error as Error).message).toContain('hashParams');
    expect((error as errors.ValidationError).reasons[0]).toBe('/hashParams/0 a symbol is not data');
  });
});

describe('AK3, AK4: the error constructors copy their lists and bound every text', () => {
  const MB = 'k'.repeat(1_000_000);
  const many = Array.from({ length: 20_000 }, (_, index) => `id-${index}`);

  it('a list argument is read once: an Array subclass, a getter list, a changing element', () => {
    class Ev extends Array {}
    // An Array subclass whose `every` always says yes and whose `join` throws.
    Object.defineProperty(Ev.prototype, 'every', { value: () => true });
    Object.defineProperty(Ev.prototype, 'join', {
      value: () => {
        throw new Error('join ran');
      },
    });
    for (const bad of [Ev.of(Symbol('s') as never), Ev.of({ toString: () => 'x' } as never)]) {
      const e1 = outcome(() => new errors.RuleConflictError(bad as never, 1));
      expect(isEngineError(e1)).toBe(true);
      const e2 = outcome(() => new errors.OutputNotFiniteError('o', bad as never));
      expect(isEngineError(e2)).toBe(true);
      const e3 = outcome(() => new errors.ValidationError('x', bad as never));
      expect(isEngineError(e3)).toBe(true);
    }
    let reads = 0;
    const changing = Object.defineProperty([], 0, {
      enumerable: true,
      get: () => (++reads === 1 ? 'a' : Symbol('s')),
    });
    expect(isEngineError(outcome(() => new errors.RuleConflictError(changing as never, 1)))).toBe(
      true,
    );
    expect(reads).toBe(0);
  });

  it('enumerated and numeric arguments outside their type are refused', () => {
    for (const make of [
      () => new errors.PluginHookError('p', 'nothook' as never, new Error('x')),
      () => new errors.SnapshotFailureError(new Error('x'), 'bogus' as never),
      () => new errors.DSLTimeoutError('d', NaN),
      () => new errors.HookTimeoutError('p', 'onError' as never, 5),
      () => new errors.EngineLimitError('nonsense' as never, 1, 2),
      () => new errors.PipelineTimeoutError(Infinity),
    ]) {
      const error = outcome(make);
      expect(error).toBeInstanceOf(errors.EngineConfigError);
    }
  });

  it('a message built from many long items is clipped under one bound', () => {
    const long = Array.from({ length: 100 }, () => 'a'.repeat(300));
    const error = new errors.RuleConflictError(long, 1);
    expect(error.message.length).toBeLessThanOrEqual(2200);
    expect(error.message).toContain('[clipped]');
  });

  it('PPEError keeps a string code and a fixed text for a bad message', () => {
    const e = new errors.PPEError(5 as never, { toString: () => 'x' } as never);
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(e.message).toBe('invalid error message');
  });

  it('every text and list is bounded: a 1 MB key and 20 000 items, for each class', () => {
    const built: Error[] = [
      new errors.ValidationError('y'.repeat(300_000), many),
      new errors.RuleConflictError(many, 1),
      new errors.OutputNotFiniteError(MB, many),
      new errors.InvalidModelError(MB, many),
      new errors.ModelNotFoundError(MB),
      new errors.DSLNotFoundError(MB),
      new errors.DuplicateRequestError(MB),
      new errors.FrozenViewWriteError(MB),
      new errors.ChecksumMismatchError(MB, MB),
      new errors.EngineConfigError(MB, MB),
      new errors.CallbackError(MB, new Error(MB)),
      new errors.PluginHookError(MB, 'onInit', new Error(MB)),
      new errors.ExceptionPrecedenceError(MB, MB, MB, MB),
      new errors.DecimalPrecisionError(MB, 1),
      new errors.EngineLimitError('maxRules', 1, 2, MB, MB),
    ];
    for (const error of built) {
      expect(error.message.length, error.name).toBeLessThanOrEqual(2200);
    }
    expect((built[0] as errors.ValidationError).reasons.length).toBeLessThanOrEqual(101);
    expect((built[1] as errors.RuleConflictError).ruleIds.length).toBeLessThanOrEqual(101);
    expect((built[2] as errors.OutputNotFiniteError).contributors.length).toBeLessThanOrEqual(101);
    expect((built[3] as errors.InvalidModelError).issues.length).toBeLessThanOrEqual(101);
  });

  it('the texts of the refusals of the helpers and of evaluate options are bounded', async () => {
    const helper = outcome(() => core.hashParams({ [MB]: Symbol('s') } as never)) as Error;
    expect(helper.message.length).toBeLessThan(2200);
    expect(((helper as errors.ValidationError).reasons[0] ?? '').length).toBeLessThan(600);
    const checksum = outcome(() =>
      core.computeRuleChecksum({ [MB]: Symbol('s') } as never),
    ) as Error;
    expect(checksum.message.length).toBeLessThan(2200);
    const engine = new PPEEngine({ plugins: [host], dsls: [], strict: false });
    const options = (await rejection(() =>
      engine.evaluate([], makeInput(), { [MB]: 1 } as never),
    )) as errors.ValidationError;
    expect(options.reasons.every((reason) => reason.length < 600)).toBe(true);
    const accessor = (await rejection(() =>
      engine.evaluate(
        [],
        makeInput(),
        Object.defineProperty({}, MB, { enumerable: true, get: () => 1 }) as never,
      ),
    )) as errors.ValidationError;
    expect(accessor.reasons.every((reason) => reason.length < 600)).toBe(true);
  });
});

describe('AK5: the derive answer is checked before it is read', () => {
  const run = async (answer: () => unknown): Promise<unknown> =>
    rejection(() =>
      new PPEEngine({
        plugins: [host],
        dsls: [],
        strict: false,
        inputSeed: { derive: answer as never },
      }).evaluate([makeRule({ id: 'tax', model: 'tax' })], makeInput()),
    );

  it('a Proxy answer is refused with no trap run', async () => {
    const log: string[] = [];
    const error = await run(() => recording(new Uint8Array(32), log));
    expect(error).toBeInstanceOf(errors.CallbackError);
    expect(log).toEqual([]);
  });

  it('an answer with a then getter, own or inherited, is refused and the getter never runs', async () => {
    let runs = 0;
    const own = Object.defineProperty(new Uint8Array(32), 'then', {
      get() {
        runs += 1;
        return undefined;
      },
    });
    class WithThen extends Uint8Array {
      get then(): undefined {
        runs += 1;
        return undefined;
      }
    }
    for (const answer of [own, new WithThen(32)]) {
      const error = await run(() => answer);
      expect(error).toBeInstanceOf(errors.CallbackError);
      expect((error as Error).message).toContain('thenable');
    }
    expect(runs).toBe(0);
  });
});

describe('AK9: describing a fault runs no foreign code', () => {
  it('a symbol is described without Symbol.prototype.toString', () => {
    const original = Symbol.prototype.toString;
    let runs = 0;
    Symbol.prototype.toString = function (): string {
      runs += 1;
      return 'polluted';
    };
    try {
      const error = new errors.CallbackError('x', Symbol('s'));
      expect(error.message).toBe('callback x failed: Symbol(s)');
    } finally {
      Symbol.prototype.toString = original;
    }
    expect(runs).toBe(0);
  });

  it('a Proxy cause is described by a fixed text, with no trap run', () => {
    const log: string[] = [];
    for (const make of [
      () => new errors.UnexpectedEngineError(recording({}, log)),
      () => new errors.CallbackError('x', recording({}, log)),
      () => new errors.PluginHookError('p', 'onInit', recording({}, log)),
    ]) {
      const error = make();
      expect(error.message).toContain('(a Proxy)');
    }
    expect(log).toEqual([]);
  });
});

describe('AK2: no unhandled rejection from a rejecting thenable, in a child process', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak2-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('exit code 0 and empty stderr for the rejecter shape and the nine-layer chain, in derive, onSnapshotError and the hooks', () => {
    const bundle = join(dir, 'core.mjs');
    buildSync({
      entryPoints: [join(process.cwd(), 'src/index.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent',
    });
    const script = join(dir, 'run.mjs');
    writeFileSync(
      script,
      `import { PPEEngine, computeRuleChecksum } from './core.mjs';
const model = { name: 'tax', version: '1.0.0', validateParams: () => ({ valid: true }), calculate: () => 1 };
const base = { id: 'tax', version: 1, model: 'tax', params: {}, priority: 1, effectiveFrom: '2024-01-01T00:00:00.000Z', effectiveUntil: null, tags: [] };
const rule = { ...base, checksum: computeRuleChecksum(base) };
const adapter = { exists: async () => false, save: async () => { throw new Error('disk'); } };
// the rejected promise is created lazily, inside then: an engine that never calls then never makes it
const rejecter = () => ({ then: (_ok, no) => no(Promise.reject(new Error('x'))) });
const layers = (n) => { let t = { then: (ok) => ok(Promise.reject(new Error('inner'))) }; for (let i = 0; i < n; i += 1) { const inner = t; t = { then: (ok) => ok(inner) }; } return t; };
const plugin = (extra) => ({ name: 'host', version: '1.0.0', onInit: (c) => c.modelRegistry.register(model), ...extra });
const make = (o) => new PPEEngine({ plugins: [plugin(o.plugin)], dsls: [], strict: false, snapshot: adapter, onSnapshotError: o.onSnapshotError, inputSeed: o.inputSeed });
const input = { requestId: 'r1', data: {}, meta: { tenantId: 't' } };
let n = 0;
const cases = [
  { onSnapshotError: rejecter }, { onSnapshotError: () => layers(9) }, { onSnapshotError: () => layers(10) },
  { inputSeed: { derive: rejecter } }, { inputSeed: { derive: () => layers(9) } }, { inputSeed: { derive: () => layers(12) } },
  { plugin: { beforeEvaluate: rejecter } }, { plugin: { beforeEvaluate: () => layers(9) } },
  { plugin: { afterEvaluate: rejecter } }, { plugin: { onError: rejecter, beforeEvaluate: () => { throw new Error('real'); } } },
];
for (const c of cases) {
  try { await make(c).evaluate([rule], { ...input, requestId: 'r' + (n++) }); } catch (e) { /* named engine error */ }
}
try { new PPEEngine({ plugins: [plugin({ onInit: rejecter })], dsls: [] }); } catch (e) { /* named */ }
await new Promise((r) => setTimeout(r, 80));
console.log('alive');
`,
    );
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe('alive');
    expect(run.status).toBe(0);
  });
});

describe('AK8: the names in the texts of the exported registries, from the built bundle', () => {
  it('the public names, a ValidationError naming the method, and a detached call named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ak8-'));
    try {
      const bundle = join(dir, 'core.mjs');
      buildSync({
        entryPoints: [join(process.cwd(), 'src/index.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: bundle,
        logLevel: 'silent',
      });
      const script = join(dir, 'run.mjs');
      writeFileSync(
        script,
        `import { ModelRegistry, DSLRegistry } from './core.mjs';
const out = [];
const text = (f) => { try { f(); return 'no error'; } catch (e) { return e.name + ': ' + e.message; } };
out.push(text(() => new ModelRegistry().register(new Proxy({}, {}))));
out.push(text(() => ModelRegistry.prototype.has.call(null, 'x')));
out.push(text(() => DSLRegistry.prototype.versions.call(null)));
out.push(text(() => new ModelRegistry().get(new Proxy({}, {}))));
out.push(text(() => new ModelRegistry().get(5)));
console.log(JSON.stringify(out));
`,
      );
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const lines = JSON.parse(run.stdout) as string[];
      expect(lines[0]).toMatch(/^ValidationError: ModelRegistry\.register/);
      expect(lines[1]).toMatch(/^ValidationError: ModelRegistry\.has called on something/);
      expect(lines[2]).toMatch(/^ValidationError: DSLRegistry\.versions called on something/);
      expect(lines[3]).toMatch(/^ValidationError: ModelRegistry\.get: argument 0 must be a string/);
      expect(lines[4]).toMatch(/^ValidationError: ModelRegistry\.get: argument 0 must be a string/);
      for (const line of lines) expect(line).not.toMatch(/Registry2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
