/**
 * Which error classes the engine itself defines. A plugin can subclass `PPEError`, so a prototype
 * is the engine's only if its class was marked where the class is defined. The set is private to
 * this module: nothing a plugin can reach lists it or adds to it.
 */
const ENGINE_PROTOTYPES = new WeakSet<object>();

/** Marks `cls`, a class defined by the engine, as such. */
export function markEngineError(cls: { prototype: object }): void {
  ENGINE_PROTOTYPES.add(cls.prototype);
}

/** True when `prototype` is the prototype of a class the engine marked. */
export function isEngineErrorPrototype(prototype: unknown): boolean {
  return typeof prototype === 'object' && prototype !== null && ENGINE_PROTOTYPES.has(prototype);
}

/**
 * The errors the engine created: each is added here, by identity, when it is built, and only when
 * the class being built is one the engine marked. `instanceof` is never the test: a caller or a
 * plugin can subclass `PPEError`, and its object is not the engine's.
 */
const ENGINE_INSTANCES = new WeakSet<object>();

/**
 * Completes an engine error: freezes it and, only when `newTarget` is exactly the class `Self`
 * that is finishing its own constructor, records it as the engine's own. It is the LAST step of
 * the leaf constructor, so an object that is recorded is complete and frozen. A forged object
 * (`Reflect.construct(PPEError, args, ValidationError)`, which never runs the leaf constructor)
 * and an object built by a subclass are never recorded.
 */
export function sealEngineError(
  error: object,
  newTarget: unknown,
  Self: { prototype: object },
): void {
  fixStack(error);
  Object.freeze(error);
  if (newTarget === Self) ENGINE_INSTANCES.add(error);
}

/**
 * Makes `stack` an own data string. V8 formats the trace lazily, through `Error.prepareStackTrace`
 * (a plugin can set it, and what it returns is any object, run at the first read): so it is read
 * here, once, with `prepareStackTrace` set aside for that synchronous read and restored in `finally`,
 * and an answer that is not a string is replaced by `name: message`. A frozen engine error thus
 * never carries a plugin's object, and no plugin hook runs when the error is copied later.
 */
function fixStack(error: object): void {
  const saved = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  let stack: unknown;
  try {
    if (saved !== undefined && !Reflect.deleteProperty(Error, 'prepareStackTrace')) {
      // Not configurable (a plugin made it so): set aside by assignment when it is writable.
      Reflect.set(Error, 'prepareStackTrace', undefined);
    }
    stack = (error as { stack?: unknown }).stack;
  } catch {
    stack = undefined;
  } finally {
    if (saved !== undefined) {
      if (saved.configurable === true) Object.defineProperty(Error, 'prepareStackTrace', saved);
      else Reflect.set(Error, 'prepareStackTrace', saved.value);
    }
  }
  const named = error as { name?: unknown; message?: unknown };
  const text =
    typeof stack === 'string'
      ? stack
      : `${typeof named.name === 'string' ? named.name : 'Error'}: ${typeof named.message === 'string' ? named.message : ''}`;
  Object.defineProperty(error, 'stack', {
    value: text,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

/** True for an error the engine itself created (never for a foreign subclass of `PPEError`). */
export function isEngineError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && ENGINE_INSTANCES.has(value);
}

/**
 * True for an error the engine created whose class is `name`. Identity first, then the name the
 * engine itself set on its frozen object: never `instanceof`, which a subclass or a forged
 * prototype can satisfy.
 */
export function isEngineErrorNamed(value: unknown, name: string): boolean {
  return isEngineError(value) && (value as { name?: unknown }).name === name;
}
