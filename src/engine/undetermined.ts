import { types } from 'node:util';
import { parsePointer } from '@run-iq/spec';

/**
 * What a model returns from `calculate` when it cannot compute for want of facts: the rule is
 * pending `UNDETERMINED`, never applied and never excluded (9M1, R11).
 */
export interface UndeterminedResult {
  /** The pointers of the facts the model lacks. */
  readonly missing: readonly string[];
  /** The model's own words. They stay in `detail`, never in `proofDetail`. */
  readonly reason?: string;
}

/** The marker the engine recognises: an own, non-enumerable data property of the result. */
const UNDETERMINED = Symbol.for('@run-iq/core/undetermined');

/** True for a pointer the engine accepts as a missing fact: a well-formed pointer, never `''` or a `-` index. */
function isPointer(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  try {
    return !parsePointer(value).includes('-');
  } catch {
    return false;
  }
}

/**
 * The result of a model that does not know. `missing` is a list of JSON pointers (RFC 6901, none
 * `''`, none with a `-` segment); `reason` is optional text. The result is frozen and carries the
 * engine's marker. Throws `TypeError` naming the bad item.
 */
export function undetermined(missing: readonly string[], reason?: string): UndeterminedResult {
  if (!Array.isArray(missing)) throw new TypeError('missing must be a list of pointers');
  const copy: string[] = [];
  for (const [index, item] of (missing as readonly unknown[]).entries()) {
    if (!isPointer(item)) {
      throw new TypeError(`missing[${index}] is not a JSON pointer`);
    }
    copy.push(item as string);
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw new TypeError('reason must be a string');
  }
  const result: { missing: readonly string[]; reason?: string } = {
    missing: Object.freeze(copy),
    ...(reason === undefined ? {} : { reason }),
  };
  Object.defineProperty(result, UNDETERMINED, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(result);
}

/** True only for an object with the engine's marker as an own data property equal to `true`. Never throws. */
export function isUndetermined(value: unknown): value is UndeterminedResult {
  try {
    if (typeof value !== 'object' || value === null) return false;
    // A Proxy is told without running a trap, and is never the engine's own marker.
    if (types.isProxy(value)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, UNDETERMINED);
    return descriptor !== undefined && 'value' in descriptor && descriptor.value === true;
  } catch {
    return false;
  }
}
