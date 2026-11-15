import { types } from 'node:util';
import type { SpecError } from '@run-iq/spec';

/**
 * Tells what an error is without `instanceof` (which a subclass, a forged prototype or a patched
 * `Symbol.hasInstance` can satisfy): a native error by its internal slot (`util.types.isNativeError`),
 * and its `name` and `code` by data descriptors, own or inherited, never by `[[Get]]`, so no getter
 * and no trap of the thrown value runs. Used only on values that engine code or spec produced.
 */
function dataString(value: object, key: string): string | undefined {
  let holder: object | null = value;
  for (let depth = 0; holder !== null && depth < 16; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    if (descriptor !== undefined) {
      return 'value' in descriptor && typeof descriptor.value === 'string'
        ? descriptor.value
        : undefined;
    }
    holder = Object.getPrototypeOf(holder) as object | null;
  }
  return undefined;
}

/** True for a native error whose `name` is `name` (`SpecError`, `RangeError`, `TypeError`). */
export function isErrorNamed(value: unknown, name: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (types.isProxy(value) || !types.isNativeError(value)) return false;
  return dataString(value, 'name') === name;
}

/** True for a spec error (`SpecError`), optionally of one `code`. */
export function isSpecError(value: unknown, code?: string): value is SpecError {
  if (!isErrorNamed(value, 'SpecError')) return false;
  return code === undefined || dataString(value as object, 'code') === code;
}
