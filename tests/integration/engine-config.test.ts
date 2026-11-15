import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { EngineConfigError } from '../../src/errors/EngineConfigError.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
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

  it('limits and inputSeed keep their own refusal (ValidationError), as before', () => {
    expect(refusal({ limits: { maxRules: -1 } })).toBeInstanceOf(ValidationError);
    expect(refusal({ inputSeed: 'x' })).toBeInstanceOf(ValidationError);
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
