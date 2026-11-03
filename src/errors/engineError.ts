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
