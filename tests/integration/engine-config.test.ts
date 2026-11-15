import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { EngineConfigError } from '../../src/errors/EngineConfigError.js';
import { PPEError } from '../../src/errors/PPEError.js';
import { CONFIG_KEYS } from '../../src/engine/engineConfig.js';
import { InMemorySnapshotAdapter, makeInput } from '../helpers.js';

// AH6: the options of `new PPEEngine` are part of the boundary. An unknown key, or a value of the
// wrong type or out of range, is refused with `EngineConfigError` and its path; nothing is coerced.

const build = (extra: Record<string, unknown>): PPEEngine =>
  new PPEEngine({ plugins: [], dsls: [], ...extra } as never);

const refusal = (extra: Record<string, unknown>): unknown => {
  try {
    build(extra);
  } catch (error) {
    return error;
  }
  return undefined;
};

const refused = (extra: Record<string, unknown>, path: string): void => {
  const error = refusal(extra);
  expect(error, `${JSON.stringify(extra)} was accepted`).toBeInstanceOf(EngineConfigError);
  expect((error as EngineConfigError).path).toBe(path);
  expect(Object.isFrozen(error)).toBe(true);
};

describe('AH6: the constructor options', () => {
  it('knows exactly the options of the config type', () => {
    expect([...CONFIG_KEYS].sort()).toEqual(
      [
        'dryRun',
        'dsls',
        'inputSeed',
        'limits',
        'onChecksumMismatch',
        'onConflict',
        'onSnapshotError',
        'plugins',
        'snapshot',
        'strict',
        'timeout',
      ].sort(),
    );
  });

  it('refuses a misspelled key, whatever its value, naming it', () => {
    refused({ strcit: false }, '/strcit');
    refused({ dryrun: undefined }, '/dryrun');
    refused({ timeout: { pipline: 5 } }, '/timeout/pipline');
  });

  it('refuses options that are not an object', () => {
    for (const given of [null, undefined, 5, 'x', []]) {
      let error: unknown;
      try {
        new PPEEngine(given as never);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(EngineConfigError);
      expect((error as EngineConfigError).path).toBe('/');
    }
  });

  it('plugins and dsls: a list, never a string or a missing member', () => {
    refused({ plugins: 'x' }, '/plugins');
    refused({ plugins: undefined }, '/plugins');
    refused({ dsls: {} }, '/dsls');
    refused({ dsls: undefined }, '/dsls');
  });

  for (const key of ['strict', 'dryRun'] as const) {
    it(`${key}: true or false, never 'no', 0 or 1`, () => {
      for (const bad of ['no', 'false', 0, 1, null]) refused({ [key]: bad }, `/${key}`);
      expect(() => build({ [key]: true })).not.toThrow();
      expect(() => build({ [key]: false })).not.toThrow();
      expect(() => build({ [key]: undefined })).not.toThrow();
    });
  }

  it("onConflict: 'throw' or 'first', a misspelling is refused", () => {
    refused({ onConflict: 'thorw' }, '/onConflict');
    refused({ onConflict: true }, '/onConflict');
    expect(() => build({ onConflict: 'first' })).not.toThrow();
    expect(() => build({ onConflict: 'throw' })).not.toThrow();
  });

  it("onChecksumMismatch: 'throw' or 'skip', a misspelling is refused", () => {
    refused({ onChecksumMismatch: 'thorw' }, '/onChecksumMismatch');
    refused({ onChecksumMismatch: 1 }, '/onChecksumMismatch');
    expect(() => build({ onChecksumMismatch: 'skip' })).not.toThrow();
    expect(() => build({ onChecksumMismatch: 'throw' })).not.toThrow();
  });

  for (const key of ['dsl', 'hook', 'pipeline'] as const) {
    it(`timeout.${key}: a number of milliseconds above 0, never a string`, () => {
      for (const bad of ['5', 0, -1, NaN, Infinity, 2 ** 31, null]) {
        refused({ timeout: { [key]: bad } }, `/timeout/${key}`);
      }
      expect(() => build({ timeout: { [key]: 5 } })).not.toThrow();
      expect(() => build({ timeout: { [key]: undefined } })).not.toThrow();
    });
  }

  it('timeout: an object', () => {
    refused({ timeout: 5 }, '/timeout');
    refused({ timeout: [] }, '/timeout');
  });

  it('snapshot: an adapter with exists and save', () => {
    refused({ snapshot: 'db' }, '/snapshot');
    refused({ snapshot: null }, '/snapshot');
    refused({ snapshot: { save: () => 'x' } }, '/snapshot/exists');
    refused({ snapshot: { exists: () => false } }, '/snapshot/save');
    expect(() => build({ snapshot: new InMemorySnapshotAdapter() })).not.toThrow();
  });

  it('onSnapshotError: a function', () => {
    refused({ onSnapshotError: 'log' }, '/onSnapshotError');
    expect(() => build({ onSnapshotError: () => undefined })).not.toThrow();
  });

  it('limits and inputSeed faults are EngineConfigError with their path (AI4)', () => {
    refused({ limits: { maxRules: -1 } }, '/limits');
    refused({ limits: 'x' }, '/limits');
    refused({ inputSeed: 'x' }, '/inputSeed');
    refused({ inputSeed: { secret: new Uint8Array(3) } }, '/inputSeed');
  });

  it('an unknown inputSeed key is refused (AI4 b)', () => {
    refused({ inputSeed: { secret: new Uint8Array(32), extra: 1 } }, '/inputSeed/extra');
  });

  it('an unknown limit name is clipped in the error (AI4 a)', () => {
    const error = refusal({ limits: { ['k'.repeat(100_000)]: 1 } }) as EngineConfigError;
    expect(error).toBeInstanceOf(EngineConfigError);
    expect(error.message.length).toBeLessThan(1500);
  });

  it('a getter or a Proxy in limits or inputSeed is named, not raw (AI1)', () => {
    const boom = (): never => {
      throw new Error('boom'.repeat(1000));
    };
    const proxy = new Proxy({}, { ownKeys: boom });
    for (const [key, value] of [
      ['limits', Object.defineProperty({}, 'maxRules', { enumerable: true, get: boom })],
      ['limits', proxy],
      ['inputSeed', Object.defineProperty({}, 'secret', { enumerable: true, get: boom })],
      ['inputSeed', proxy],
    ] as const) {
      const error = refusal({ [key]: value });
      expect(error, key).toBeInstanceOf(EngineConfigError);
      expect(Object.isFrozen(error)).toBe(true);
      expect((error as EngineConfigError).path.startsWith(`/${key}`)).toBe(true);
      expect((error as Error).message.length).toBeLessThan(1500);
    }
  });

  it('a foreign subclass of PPEError thrown by a getter is wrapped, never handed over (AI1)', () => {
    class Foreign extends PPEError {
      constructor() {
        super('mine', 'FOREIGN');
      }
    }
    const own = Object.defineProperty({}, 'maxRules', {
      enumerable: true,
      get() {
        throw new Foreign();
      },
    });
    const error = refusal({ limits: own });
    expect(error).toBeInstanceOf(EngineConfigError);
    expect(error).not.toBeInstanceOf(Foreign);
    expect(Object.isFrozen(error)).toBe(true);
  });

  it('only own data properties are options (AI4 c, d)', () => {
    // a non-enumerable key, a symbol key, an accessor, an inherited value
    const base = (): Record<string, unknown> => ({ plugins: [], dsls: [] });
    const direct = (config: object, path: string): void => {
      let error: unknown;
      try {
        new PPEEngine(config as never);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, path).toBeInstanceOf(EngineConfigError);
      expect((error as EngineConfigError).path).toBe(path);
    };
    direct(Object.defineProperty(base(), 'strcit', { value: false, enumerable: false }), '/strcit');
    direct(Object.assign(base(), { [Symbol('x')]: 1 }), '/(symbol)');
    direct(
      Object.defineProperty(base(), 'strict', { enumerable: true, get: () => true }),
      '/strict',
    );
    // an object that inherits its options is not a plain object: refused, never read (AJ6)
    direct(Object.assign(Object.create({ dryRun: true }), { plugins: [], dsls: [] }), '/');
    refused({ timeout: Object.create({ pipeline: 5 }) }, '/timeout');
  });

  it('a polluted Object.prototype is not read as an option (AI4 d)', () => {
    (Object.prototype as Record<string, unknown>)['dryRun'] = true;
    try {
      const engine = build({});
      expect((engine as unknown as { dryRun: boolean }).dryRun).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>)['dryRun'];
    }
  });

  it('a fractional delay is refused, never rounded (AI4 e)', () => {
    for (const key of ['dsl', 'hook', 'pipeline'] as const) {
      refused({ timeout: { [key]: 0.5 } }, `/timeout/${key}`);
      refused({ timeout: { [key]: 1.5 } }, `/timeout/${key}`);
    }
  });

  it('a getter or a Proxy of the options that throws is named, not raw', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile'.repeat(1000));
        },
      },
    );
    let error: unknown;
    try {
      new PPEEngine(hostile as never);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(EngineConfigError);
    expect((error as Error).message.length).toBeLessThan(1400);
  });

  it("dryRun: 'no' no longer silently stops saving", async () => {
    const adapter = new InMemorySnapshotAdapter();
    expect(() => build({ dryRun: 'no', snapshot: adapter })).toThrow(EngineConfigError);
    const engine = build({ dryRun: false, snapshot: adapter, strict: false });
    await engine.evaluate([], makeInput());
    expect(await adapter.exists(makeInput().requestId)).toBe(true);
  });
});
