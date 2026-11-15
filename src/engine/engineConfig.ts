import { EngineConfigError } from '../errors/EngineConfigError.js';
import { describeThrown } from '../utils/values.js';

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
/** The longest delay a timer takes (a larger one fires at once). */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface ReadConfig {
  readonly plugins: readonly unknown[];
  readonly dsls: readonly unknown[];
  readonly snapshot: unknown;
  readonly strict: boolean | undefined;
  readonly timeout: { dsl?: number; hook?: number; pipeline?: number };
  readonly onConflict: 'throw' | 'first' | undefined;
  readonly onChecksumMismatch: 'throw' | 'skip' | undefined;
  readonly dryRun: boolean | undefined;
  readonly onSnapshotError: ((error: unknown) => void) | undefined;
  readonly limits: unknown;
  readonly inputSeed: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
    if (error instanceof EngineConfigError) throw error;
    // A revoked Proxy, a trap or a getter that throws: named, not raw.
    throw new EngineConfigError('/', `the options could not be read: ${describeThrown(error)}`);
  }
}

function read(config: unknown): ReadConfig {
  if (!isRecord(config)) throw new EngineConfigError('/', 'the options must be an object');
  for (const key of Object.keys(config)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new EngineConfigError(`/${key}`, 'unknown option');
    }
  }
  const value = (key: (typeof CONFIG_KEYS)[number]): unknown => config[key];

  const list = (key: 'plugins' | 'dsls'): readonly unknown[] => {
    const given = value(key);
    if (!Array.isArray(given)) throw new EngineConfigError(`/${key}`, 'must be a list');
    return [...(given as unknown[])];
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
    if (!isRecord(givenTimeout)) throw new EngineConfigError('/timeout', 'must be an object');
    for (const key of Object.keys(givenTimeout)) {
      if (!(TIMEOUT_KEYS as readonly string[]).includes(key)) {
        throw new EngineConfigError(`/timeout/${key}`, 'unknown option');
      }
    }
    for (const key of TIMEOUT_KEYS) {
      const delay = givenTimeout[key];
      if (delay === undefined) continue;
      if (
        typeof delay !== 'number' ||
        !Number.isFinite(delay) ||
        delay <= 0 ||
        delay > MAX_DELAY_MS
      ) {
        throw new EngineConfigError(
          `/timeout/${key}`,
          `must be a number of milliseconds above 0 and at most ${MAX_DELAY_MS}`,
        );
      }
      timeout[key] = delay;
    }
  }

  const snapshot = value('snapshot');
  if (snapshot !== undefined) {
    if (typeof snapshot !== 'object' || snapshot === null) {
      throw new EngineConfigError('/snapshot', 'must be an adapter object');
    }
    const adapter = snapshot as Record<string, unknown>;
    for (const method of ['exists', 'save'] as const) {
      if (typeof adapter[method] !== 'function') {
        throw new EngineConfigError(`/snapshot/${method}`, 'must be a function');
      }
    }
  }
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
    limits: value('limits'),
    inputSeed: value('inputSeed'),
  };
}
