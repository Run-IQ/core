import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { isEngineError } from '../../src/errors/engineError.js';
import { frozenErrorCopy } from '../../src/utils/frozenCopy.js';
import { symbolText } from '../../src/utils/symbolText.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

// Round 17, lane A: AL4 (a symbol is described without Symbol.prototype.toString), AL6 (a plugin's
// Error.prepareStackTrace never runs, and `stack` of an engine error is an own string), AL7 (the
// species gap of a plugin's rejected promise is stated and its outcome documented).

const host = {
  name: 'host',
  version: '1.0.0',
  onInit: (context: { modelRegistry: { register(m: unknown): void } }) => {
    context.modelRegistry.register(new StubModel('tax', 10));
    context.modelRegistry.register({
      name: 'writer',
      version: '1.0.0',
      validateParams: () => ({ valid: true }),
      calculate: (_input: unknown, _rule: unknown, params: Record<symbol, unknown>) => {
        try {
          params[Symbol('written')] = 1;
        } catch {
          // caught: the slot of the call still holds the refusal
        }
        return 1;
      },
    });
  },
} as never;
const rules = [makeRule({ id: 'tax', model: 'tax' })];
const rejection = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => undefined,
    (error: unknown) => error,
  );

describe('AL4: a patched Symbol.prototype.toString never runs', () => {
  const original = Symbol.prototype.toString;
  let runs = 0;
  const patch = (): void => {
    runs = 0;
    Symbol.prototype.toString = function (): string {
      runs += 1;
      return 'polluted';
    };
  };
  afterEach(() => {
    Symbol.prototype.toString = original;
  });

  it('symbolText describes a symbol', () => {
    expect(symbolText(Symbol('s'))).toBe('Symbol(s)');
    expect(symbolText(Symbol())).toBe('Symbol()');
  });

  it('copyInput: a symbol key in a list (caller mode), in an object, at the root of the input and of meta', async () => {
    const engine = new PPEEngine({ plugins: [host], dsls: [], strict: false });
    const list = Object.assign([1], { [Symbol('k')]: 1 });
    const cases: Array<[string, unknown, RegExp]> = [
      ['list', makeInput({ data: { xs: list } }), /extra key: Symbol\(k\)/],
      ['object', makeInput({ data: { [Symbol('k')]: 1 } as never }), /symbol key: Symbol\(k\)/],
      ['input', { ...makeInput(), [Symbol('k')]: 1 }, /symbol key: Symbol\(k\)/],
      [
        'meta',
        makeInput({ meta: { tenantId: 't', [Symbol('k')]: 1 } as never }),
        /symbol key: Symbol\(k\)/,
      ],
    ];
    patch();
    for (const [label, input, text] of cases) {
      const error = (await rejection(() => engine.evaluate(rules, input as never))) as {
        reasons?: string[];
      };
      expect(error.reasons?.join(' '), label).toMatch(text);
    }
    expect(runs).toBe(0);
  });

  it('frozenView: a write through a symbol key; afterEvaluateTransition: a symbol field', async () => {
    patch();
    const writer = new PPEEngine({ plugins: [host], dsls: [], strict: false });
    const result = await writer.evaluate([makeRule({ id: 'w', model: 'writer' })], makeInput());
    expect(result.skippedRules[0]?.detail).toContain('Symbol(written)');
    const annotating = new PPEEngine({
      plugins: [
        host,
        {
          name: 'after',
          version: '1.0.0',
          onInit: () => undefined,
          afterEvaluate: () => ({ annotations: { a: 1 }, [Symbol('field')]: 1 }) as never,
        },
      ],
      dsls: [],
      strict: false,
    });
    const error = (await rejection(() => annotating.evaluate(rules, makeInput()))) as Error;
    expect(isEngineError(error)).toBe(true);
    expect(error.message).toContain('Symbol(field)');
    expect(runs).toBe(0);
  });
});

describe('AL6: Error.prepareStackTrace of a plugin never runs; stack is an own string', () => {
  const saved = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(Error, 'prepareStackTrace');
    else Object.defineProperty(Error, 'prepareStackTrace', saved);
  });

  it('a hook that sets it and throws: 0 runs during evaluate, the error holds a string stack', async () => {
    let runs = 0;
    const engine = new PPEEngine({
      plugins: [
        host,
        {
          name: 'hostile',
          version: '1.0.0',
          onInit: () => undefined,
          beforeEvaluate: () => {
            // Counts the calls of the hook itself (V8 calls it when it formats a trace).
            (Error as { prepareStackTrace?: unknown }).prepareStackTrace = () => {
              runs += 1;
              return { plugin: 'object' };
            };
            throw new Error('boom');
          },
        },
      ],
      dsls: [],
      strict: false,
    });
    const error = (await rejection(() => engine.evaluate(rules, makeInput()))) as Error;
    expect(isEngineError(error)).toBe(true);
    expect(typeof error.stack).toBe('string');
    expect(Object.getOwnPropertyDescriptor(error, 'stack')).toMatchObject({
      writable: false,
      configurable: false,
    });
    const cause = (error as { cause?: { stack?: unknown } }).cause;
    expect(cause?.stack === undefined || typeof cause.stack === 'string').toBe(true);
    expect(runs).toBe(0);
  });
});

describe('AL6: frozenErrorCopy never reads stack by [[Get]]', () => {
  it('an accessor stack is not run, an own data stack is kept', () => {
    let runs = 0;
    const accessor = Object.defineProperty(new Error('x'), 'stack', {
      get() {
        runs += 1;
        return 'from getter';
      },
    });
    const copy = frozenErrorCopy(accessor) as { stack?: unknown };
    expect(runs).toBe(0);
    expect(copy.stack).toBeUndefined();
    const own = Object.defineProperty(new Error('y'), 'stack', { value: 'own stack' });
    expect((frozenErrorCopy(own) as { stack?: unknown }).stack).toBe('own stack');
  });
});

describe("AL7: the species gap of a plugin's rejected promise (stated limit, known gap 10)", () => {
  it("the engine fails closed with a named error; the promise stays the plugin's own (exit 1, documented)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'al7-'));
    try {
      buildSync({
        entryPoints: [join(process.cwd(), 'src/index.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: join(dir, 'core.mjs'),
        logLevel: 'silent',
      });
      const script = join(dir, 'run.mjs');
      writeFileSync(
        script,
        `import { PPEEngine, computeRuleChecksum } from './core.mjs';
const model = { name: 'tax', version: '1.0.0', validateParams: () => ({ valid: true }), calculate: () => 1 };
const base = { id: 'tax', version: 1, model: 'tax', params: {}, priority: 1, effectiveFrom: '2024-01-01T00:00:00.000Z', effectiveUntil: null, tags: [] };
const rule = { ...base, checksum: computeRuleChecksum(base) };
const species = () => { const p = Promise.reject(new Error('late')); p.constructor = { [Symbol.species]: function () { throw new Error('species'); } }; return p; };
const engine = new PPEEngine({ plugins: [{ name: 'host', version: '1.0.0', onInit: (c) => c.modelRegistry.register(model), beforeEvaluate: species }], dsls: [], strict: false });
try { await engine.evaluate([rule], { requestId: 'r', data: {}, meta: { tenantId: 't' } }); console.log('resolved'); } catch (e) { console.log(e.name); }
await new Promise((r) => setTimeout(r, 50));
console.log('alive');
`,
      );
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      // The engine says what happened...
      expect(run.stdout.split('\n')[0]).toBe('PluginHookError');
      // ...and the plugin's own unhandled promise ends the process: the documented limit (README, B85).
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('late');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
