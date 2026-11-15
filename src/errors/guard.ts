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
  copyArgs: boolean | readonly number[] = false,
): F {
  const guarded = function (this: unknown, ...args: never[]): unknown {
    try {
      const given = copyArgs
        ? args.map((argument, position) =>
            copyArgs === true || copyArgs.includes(position)
              ? copyCallerData(argument, `/${name}/${position}`, refuseArgument(name))
              : argument,
          )
        : args;
      return Reflect.apply(fn, this, given);
    } catch (error) {
      throw asExportError(name, error);
    }
  };
  Object.defineProperty(guarded, 'name', { value: fn.name || name });
  // The arity of the implementation, so that the inventory of parameters can be generated.
  Object.defineProperty(guarded, 'length', { value: fn.length });
  return guarded as unknown as F;
}

/**
 * Guards the named methods of a class, in place, so that every instance throws engine errors only.
 * `publicName` is the name the package exports the class under (the bundle may rename the local
 * one); `brand` tells an instance the class built, so a detached call is a named error; the
 * methods in `stringArgument` take one string and refuse anything else, named.
 */
export function guardMethods(
  cls: { prototype: object },
  names: readonly string[],
  publicName: string,
  brand: WeakSet<object>,
  stringArgument: readonly string[] = [],
): void {
  for (const method of names) {
    const original = (cls.prototype as Record<string, unknown>)[method];
    if (typeof original !== 'function') throw new Error(`${publicName}.${method} is not a method`);
    const name = `${publicName}.${method}`;
    const inner = guard(name, original as (...args: never[]) => unknown);
    Object.defineProperty(cls.prototype, method, {
      value: function (this: unknown, ...args: unknown[]): unknown {
        if (typeof this !== 'object' || this === null || !brand.has(this)) {
          throw new ValidationError(`${name} called on something that is not a ${publicName}`, [
            `${name} must be called on a ${publicName}`,
          ]);
        }
        if (stringArgument.includes(method) && typeof args[0] !== 'string') {
          throw new ValidationError(`${name}: argument 0 must be a string`, [
            `/${name}/0 must be a string`,
          ]);
        }
        return Reflect.apply(inner, this, args);
      },
      writable: true,
      configurable: true,
    });
    // The arity of the method, so that the inventory of parameters can be generated.
    Object.defineProperty(cls.prototype[method as keyof typeof cls.prototype], 'length', {
      value: (original as (...args: never[]) => unknown).length,
    });
  }
}
