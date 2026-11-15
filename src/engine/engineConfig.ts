import { types } from 'node:util';
import { EngineConfigError } from '../errors/EngineConfigError.js';
import { isEngineError } from '../errors/engineError.js';
import type { ISnapshotAdapter, Snapshot } from '../types/snapshot.js';
import { copyCallerValue } from './callerCopy.js';
import { resolveLimits } from '../limits.js';
import type { EngineLimits } from '../limits.js';
import { readInputSeedConfig } from '../input/inputSeed.js';
import type { InputSeedConfig } from '../input/inputSeed.js';
import { describeFault, faultOf } from './pluginPort.js';

/** The options `new PPEEngine` knows. Any other key is refused, whatever its value. */
export const CONFIG_KEYS = [
  'plugins',
  'dsls',
  'snapshot',
  'strict',
  'timeout',
  'onConflict',
  'onChecksumMismatch',
  'dryRun',
  'onSnapshotError',
  'limits',
  'inputSeed',
] as const;
const TIMEOUT_KEYS = ['dsl', 'hook', 'pipeline'] as const;
/** The most plugins or DSLs an engine takes. */
const MAX_PLUGINS = 10_000;
/** The longest delay a timer takes (a larger one fires at once). */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface ReadConfig {
  readonly plugins: readonly unknown[];
  readonly dsls: readonly unknown[];
  readonly snapshot: ISnapshotAdapter | undefined;
  readonly strict: boolean | undefined;
  readonly timeout: { dsl?: number; hook?: number; pipeline?: number };
  readonly onConflict: 'throw' | 'first' | undefined;
  readonly onChecksumMismatch: 'throw' | 'skip' | undefined;
  readonly dryRun: boolean | undefined;
  readonly onSnapshotError: ((error: unknown) => void) | undefined;
  readonly limits: EngineLimits;
  readonly inputSeed: InputSeedConfig | undefined;
}

/**
 * Reads the options once, checks them and returns the engine's own copy. An unknown key, or a
 * value of the wrong type or out of range, is refused with `EngineConfigError` and its path; a
 * value is never coerced (`dryRun: 'no'` is not truthy, `timeout.pipeline: '5'` is not 5). The
 * members that have a checker of their own (`limits`, `inputSeed`) are handed on as given.
 */
export function readEngineConfig(config: unknown): ReadConfig {
  try {
    return read(config);
  } catch (error) {
    if (isEngineError(error)) throw error;
    // A revoked Proxy, a trap or a getter that throws: named, not raw.
    throw new EngineConfigError(
      '/',
      `the options could not be read: ${describeFault(faultOf(error))}`,
    );
  }
}

function read(given: unknown): ReadConfig {
  const config = copyCallerValue(given, '/', { kind: 'record', known: CONFIG_KEYS });
  const value = (key: (typeof CONFIG_KEYS)[number]): unknown => config[key];

  const list = (key: 'plugins' | 'dsls'): readonly unknown[] => {
    return copyCallerValue(value(key), `/${key}`, { kind: 'list', max: MAX_PLUGINS });
  };
  const flag = (key: 'strict' | 'dryRun'): boolean | undefined => {
    const given = value(key);
    if (given !== undefined && typeof given !== 'boolean') {
      throw new EngineConfigError(`/${key}`, 'must be true or false');
    }
    return given;
  };
  const choice = <T extends string>(
    key: 'onConflict' | 'onChecksumMismatch',
    allowed: readonly T[],
  ): T | undefined => {
    const given = value(key);
    if (given === undefined) return undefined;
    if (typeof given !== 'string' || !(allowed as readonly string[]).includes(given)) {
      throw new EngineConfigError(`/${key}`, `must be one of ${allowed.join(', ')}`);
    }
    return given as T;
  };

  const timeout: { dsl?: number; hook?: number; pipeline?: number } = {};
  const givenTimeout = value('timeout');
  if (givenTimeout !== undefined) {
    const own = copyCallerValue(givenTimeout, '/timeout', { kind: 'record', known: TIMEOUT_KEYS });
    for (const key of TIMEOUT_KEYS) {
      const delay = own[key];
      if (delay === undefined) continue;
      if (
        typeof delay !== 'number' ||
        !Number.isSafeInteger(delay) ||
        delay <= 0 ||
        delay > MAX_DELAY_MS
      ) {
        throw new EngineConfigError(
          `/timeout/${key}`,
          `must be a whole number of milliseconds above 0 and at most ${MAX_DELAY_MS}`,
        );
      }
      timeout[key] = delay;
    }
  }

  const snapshot = captureAdapter(value('snapshot'));
  const onSnapshotError = value('onSnapshotError');
  if (onSnapshotError !== undefined && typeof onSnapshotError !== 'function') {
    throw new EngineConfigError('/onSnapshotError', 'must be a function');
  }

  return {
    plugins: list('plugins'),
    dsls: list('dsls'),
    snapshot,
    strict: flag('strict'),
    timeout,
    onConflict: choice('onConflict', ['throw', 'first'] as const),
    onChecksumMismatch: choice('onChecksumMismatch', ['throw', 'skip'] as const),
    dryRun: flag('dryRun'),
    onSnapshotError: onSnapshotError as ReadConfig['onSnapshotError'],
    limits: readLimits(value('limits')),
    inputSeed: readSeed(value('inputSeed')),
  };
}

/** A `ValidationError` of a member that has its own checker, as an `EngineConfigError` with the path. */
function asConfigError(path: string, error: unknown): never {
  // By identity: only an error the engine created is read, and only its own frozen text.
  if (isEngineError(error)) {
    const engine = error as { name: string; reasons?: readonly string[] };
    if (engine.name === 'EngineConfigError') throw error;
    if (engine.name === 'ValidationError' && Array.isArray(engine.reasons)) {
      throw new EngineConfigError(path, engine.reasons.join('; '));
    }
  }
  throw new EngineConfigError(path, `could not be read: ${describeFault(faultOf(error))}`);
}

function readLimits(given: unknown): EngineLimits {
  if (given === undefined) return resolveLimits(undefined);
  try {
    return resolveLimits(copyCallerValue(given, '/limits', { kind: 'record' }));
  } catch (error) {
    return asConfigError('/limits', error);
  }
}

function readSeed(given: unknown): InputSeedConfig | undefined {
  if (given === undefined) return undefined;
  try {
    return readInputSeedConfig(
      copyCallerValue(given, '/inputSeed', { kind: 'record', known: ['secret', 'derive'] }),
      given,
    );
  } catch (error) {
    return asConfigError('/inputSeed', error);
  }
}

/** A data property that is a function, own or inherited, by descriptor: an accessor is never run. */
function dataFunction(source: object, key: string, path: string): (...args: never[]) => unknown {
  let holder: object | null = source;
  for (let depth = 0; holder !== null && depth < 16; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) {
        throw new EngineConfigError(path, 'must be a data property, not an accessor');
      }
      if (typeof descriptor.value !== 'function')
        throw new EngineConfigError(path, 'must be a function');
      return descriptor.value as (...args: never[]) => unknown;
    }
    holder = Object.getPrototypeOf(holder) as object | null;
  }
  throw new EngineConfigError(path, 'must be a function');
}

/**
 * The snapshot adapter is a class instance by design, so it is not copied; it crosses here, once:
 * a Proxy is refused, `exists` and `save` are captured by descriptor (own or inherited data
 * functions, an accessor refused) and the engine keeps an object of its own that calls those
 * captured functions on the adapter. The function checked is the function called, at every
 * evaluation; a fault is named at `/snapshot/<method>`.
 */
function captureAdapter(given: unknown): ISnapshotAdapter | undefined {
  if (given === undefined) return undefined;
  if (typeof given !== 'object' || given === null) {
    throw new EngineConfigError('/snapshot', 'must be an adapter object');
  }
  if (types.isProxy(given)) throw new EngineConfigError('/snapshot', 'must not be a Proxy');
  const exists = dataFunction(given, 'exists', '/snapshot/exists');
  const save = dataFunction(given, 'save', '/snapshot/save');
  return Object.freeze({
    exists: (requestId: string) => Reflect.apply(exists, given, [requestId]) as Promise<boolean>,
    save: (snapshot: Snapshot) => Reflect.apply(save, given, [snapshot]) as Promise<string>,
  }) as unknown as ISnapshotAdapter;
}
