import { ValidationError } from './ValidationError.js';
import { isEngineError } from './engineError.js';
import { describeThrown } from '../utils/values.js';
import { copyCallerData } from '../engine/callerCopy.js';

/** A refusal of the copier, for an exported function: a `ValidationError` naming it. */
const refuseArgument = (name: string) => (path: string, reason: string) =>
  new ValidationError(`${name}: ${path} ${reason}`, [`${path} ${reason}`]);

/**
 * What a function the package exports throws, whatever went wrong inside: an error the engine
 * created is itself; anything else (a `TypeError` of a bad argument, a `SpecError`, a hostile
 * getter) is a `ValidationError` naming the function and holding the bounded text of the fault,
 * never the object (AI7). Identity, not `instanceof`, tells the engine's own.
 */
export function asExportError(name: string, error: unknown): Error {
  if (isEngineError(error)) return error as Error;
  const text = describeThrown(error);
  return new ValidationError(`${name}: ${text}`, [text]);
}

/** `fn`, with every throw turned into an engine error (see `asExportError`). */
export function guard<F extends (...args: never[]) => unknown>(
  name: string,
  fn: F,
  /** Copy every argument through the inbound copier first (the data helpers). */
  copyArgs = false,
): F {
  const guarded = function (this: unknown, ...args: never[]): unknown {
    try {
      const given = copyArgs
        ? args.map((argument, position) =>
            copyCallerData(argument, `/${name}/argument${position}`, refuseArgument(name)),
          )
        : args;
      return Reflect.apply(fn, this, given);
    } catch (error) {
      throw asExportError(name, error);
    }
  };
  Object.defineProperty(guarded, 'name', { value: fn.name || name });
  return guarded as unknown as F;
}

/** Guards the named methods of a class, in place, so that every instance throws engine errors only. */
export function guardMethods(
  cls: { prototype: object; name: string },
  names: readonly string[],
): void {
  for (const method of names) {
    const original = (cls.prototype as Record<string, unknown>)[method];
    if (typeof original !== 'function') throw new Error(`${cls.name}.${method} is not a method`);
    Object.defineProperty(cls.prototype, method, {
      value: guard(`${cls.name}.${method}`, original as (...args: never[]) => unknown),
      writable: true,
      configurable: true,
    });
  }
}
