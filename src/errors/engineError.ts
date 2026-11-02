/**
 * Which error classes the engine itself defines. A plugin can subclass `PPEError`, so a prototype
 * is the engine's only if its class was marked here, where the class is defined: a copy of an
 * error keeps the prototype of an engine class (and of the language's own error classes), and gives
 * anything else the plain `Error` prototype.
 */
const ENGINE = Symbol('run-iq.engine-error');

/** Marks `cls`, a class defined by the engine, as such. */
export function markEngineError(cls: { prototype: object }): void {
  Object.defineProperty(cls, ENGINE, { value: true, enumerable: false });
}

/** True when `prototype` is the prototype of a class the engine marked. */
export function isEngineErrorPrototype(prototype: unknown): boolean {
  if (typeof prototype !== 'object' || prototype === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  const ctor: unknown = descriptor?.value;
  if (typeof ctor !== 'function') return false;
  return (
    Object.getOwnPropertyDescriptor(ctor, ENGINE)?.value === true &&
    (ctor as { prototype?: unknown }).prototype === prototype
  );
}
