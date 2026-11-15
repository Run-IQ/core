import { EngineConfigError } from './EngineConfigError.js';
import { copyCallerValue } from '../engine/callerCopy.js';
import { clipText } from '../utils/weight.js';

/**
 * The arguments of the constructors of the exported error classes. A bad argument is refused with
 * a frozen `EngineConfigError` naming the class and the position, never a raw `TypeError` from a
 * template string or a `join`; a list is copied once through the inbound copier (a plain list, read
 * by descriptor) and only the copy is used; every text is clipped under one declared bound.
 */
export const MAX_ARGUMENT_TEXT = 256;
/** The most items a list argument keeps; the rest are counted (`... and K more`). */
export const MAX_ARGUMENT_ITEMS = 100;
const MARK = '... [clipped]';
const MAX_SCANNED = 1_000_000;

const where = (cls: string, position: number): string => `/${cls}/argument${position}`;

/** A string, clipped on a code point to `MAX_ARGUMENT_TEXT`. */
export function str(
  cls: string,
  position: number,
  value: unknown,
  max = MAX_ARGUMENT_TEXT,
): string {
  if (typeof value !== 'string') {
    throw new EngineConfigError(where(cls, position), 'must be a string');
  }
  return clipText(value, max, MARK);
}

/** A string or `undefined`. */
export function optStr(cls: string, position: number, value: unknown): string | undefined {
  return value === undefined ? undefined : str(cls, position, value);
}

/** A finite number. */
export function num(cls: string, position: number, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EngineConfigError(where(cls, position), 'must be a finite number');
  }
  return value;
}

/** One of `allowed`. */
export function oneOf<T extends string>(
  cls: string,
  position: number,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new EngineConfigError(where(cls, position), `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * A list of strings, copied once: the first `MAX_ARGUMENT_ITEMS` items, each clipped, then
 * `... and K more` when there are more. Only the copy is read afterwards.
 */
export function strings(cls: string, position: number, value: unknown): readonly string[] {
  const copy = copyCallerValue(
    value,
    where(cls, position),
    { kind: 'list', max: MAX_SCANNED },
    (path, reason) => new EngineConfigError(path, reason),
  );
  const kept: string[] = [];
  for (const [index, item] of copy.entries()) {
    if (typeof item !== 'string') {
      throw new EngineConfigError(`${where(cls, position)}/${index}`, 'must be a string');
    }
    if (index < MAX_ARGUMENT_ITEMS) kept.push(clipText(item, MAX_ARGUMENT_TEXT, MARK));
  }
  if (copy.length > MAX_ARGUMENT_ITEMS) {
    kept.push(`... and ${copy.length - MAX_ARGUMENT_ITEMS} more`);
  }
  return Object.freeze(kept);
}
