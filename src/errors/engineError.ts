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

/** Records `error` as the engine's own when `newTarget` is a class the engine marked. */
export function recordEngineInstance(error: object, newTarget: { prototype: object }): void {
  if (ENGINE_PROTOTYPES.has(newTarget.prototype)) ENGINE_INSTANCES.add(error);
}

/** True for an error the engine itself created (never for a foreign subclass of `PPEError`). */
export function isEngineError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && ENGINE_INSTANCES.has(value);
}
