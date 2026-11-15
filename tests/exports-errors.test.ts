import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../src/index.js';
import { isEngineError } from '../src/errors/engineError.js';

// AI7: every function the package exports, called with a bad argument, throws only a frozen error
// of an exported engine class: never a raw `TypeError`, `Error` or `SpecError`.

const hostile = (): unknown =>
  new Proxy(
    {},
    {
      get() {
        throw new Error('trap '.repeat(5000));
      },
      ownKeys() {
        throw new Error('trap');
      },
      getPrototypeOf() {
        throw new Error('trap');
      },
    },
  );

const bad: unknown[] = [undefined, null, 5, 'x', Symbol('s'), () => 1, [], {}, hostile()];

const callables: Array<[string, (argument: unknown) => unknown]> = [
  ['hydrateRule', (a) => core.hydrateRule(a as never)],
  ['hydrateRules', (a) => core.hydrateRules(a as never)],
  ['canonicalStringify', (a) => core.canonicalStringify(a as never)],
  ['hashParams', (a) => core.hashParams(a as never)],
  ['computeRuleChecksum', (a) => core.computeRuleChecksum(a as never)],
  ['resolveLimits', (a) => core.resolveLimits(a as never)],
  ['normalizeMeta', (a) => core.normalizeMeta(a as never)],
  ['evaluationDate', (a) => core.evaluationDate(a as never)],
  ['readsOf', (a) => core.readsOf(a as never, a as never, a as never)],
  ['buildContext', (a) => core.buildContext(a as never, a as never)],
  ['formatPointer', (a) => core.formatPointer(a as never)],
  ['parsePointer', (a) => core.parsePointer(a as never)],
  ['ModelRegistry.register', (a) => new core.ModelRegistry().register(a as never)],
  ['ModelRegistry.get', (a) => new core.ModelRegistry().get(a as never)],
  ['ModelRegistry.describe', (a) => new core.ModelRegistry().describe(a as never)],
  ['DSLRegistry.register', (a) => new core.DSLRegistry().register(a as never)],
];

const outcome = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('AJ: no exported data helper reads its argument before the inbound copier', () => {
  it('guardedApi.ts passes every data helper through copyCallerData (a grep check)', () => {
    const text = readFileSync(join(process.cwd(), 'src/guardedApi.ts'), 'utf8');
    for (const name of [
      'hydrateRule',
      'hydrateRules',
      'canonicalStringify',
      'hashParams',
      'computeRuleChecksum',
      'resolveLimits',
      'normalizeMeta',
      'evaluationDate',
      'buildContext',
      'formatPointer',
      'parsePointer',
    ]) {
      expect(text, name).toMatch(new RegExp(`guard\\('${name}', ${name}Impl, true\\)`));
    }
  });
});

describe('AI7: the exported helpers throw engine errors only', () => {
  it('covers every function the package exports (a new export fails this until it is listed)', () => {
    const exempt = new Set(['PPEEngine']); // its errors are tested through the engine
    const functions = Object.entries(core)
      .filter(([, value]) => typeof value === 'function')
      .filter(([, value]) => !((value as { prototype?: unknown }).prototype instanceof Error))
      .filter(([name]) => name !== 'PPEError' && !exempt.has(name))
      .map(([name]) => name)
      .sort();
    const covered = new Set(callables.map(([name]) => name.split('.')[0]));
    expect(functions.filter((name) => !covered.has(name))).toEqual([]);
  });

  for (const [name, call] of callables) {
    it(`${name}: whatever it is given, a throw is a frozen engine error`, () => {
      for (const argument of bad) {
        const error = outcome(() => call(argument));
        if (error === undefined) continue; // an argument it accepts
        expect(isEngineError(error), `${name} threw ${String(error)}`).toBe(true);
        expect(Object.isFrozen(error)).toBe(true);
        expect((error as Error).message.length).toBeLessThan(1400);
      }
    });
  }

  it('a duplicate model and a duplicate DSL are engine errors', () => {
    const model = {
      name: 'm',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: () => 1,
    };
    const registry = new core.ModelRegistry();
    registry.register(model as never);
    const error = outcome(() => registry.register(model as never));
    expect(error).toBeInstanceOf(core.ValidationError);
    expect(Object.isFrozen(error)).toBe(true);
    const dsls = new core.DSLRegistry();
    const dsl = { dsl: 'd', version: '1.0.0', evaluate: () => true };
    dsls.register(dsl);
    expect(outcome(() => dsls.register(dsl))).toBeInstanceOf(core.ValidationError);
  });

  it('the registries keep their class names and still work as before', () => {
    expect(core.ModelRegistry.name).toBe('ModelRegistry');
    expect(core.DSLRegistry.name).toBe('DSLRegistry');
    expect(new core.ModelRegistry().has('x')).toBe(false);
  });

  it("spec's own SpecError never reaches the caller", () => {
    const error = outcome(() => core.computeRuleChecksum(null as never));
    expect(isEngineError(error)).toBe(true);
  });
});
