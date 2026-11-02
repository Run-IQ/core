// One definition of "plain", the one of `@run-iq/spec` (`isPlainObject` in spec's `values.ts`):
// a non-list object whose prototype is `null`, or `Object.prototype` of this realm or of another.
// Core cannot import it (spec does not export it), so it is repeated here exactly, and a test
// holds the two together on the same cases. The engine decides plainness once per object, from
// one `Object.getPrototypeOf`, and never asks spec about the original.

/** True for `Object.prototype` of another realm (spec's `isForeignObjectPrototype`). */
function isForeignObjectPrototype(proto: unknown): boolean {
  if (proto === null || typeof proto !== 'object') return false;
  if (Object.getPrototypeOf(proto) !== null || Object.keys(proto).length > 0) return false;
  const ctor: unknown = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
  return (
    typeof ctor === 'function' &&
    ctor.name === 'Object' &&
    (ctor as { prototype?: unknown }).prototype === proto
  );
}

/** True when an object with this prototype is plain (and is not a list). */
export function isPlainPrototype(proto: unknown): boolean {
  return proto === null || proto === Object.prototype || isForeignObjectPrototype(proto);
}

/** True for a `Date` of any realm: the brand check, not the prototype. */
export function isDateObject(value: object): boolean {
  try {
    Date.prototype.getTime.call(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * What stands in the copy for an object that is not plain (a class instance, a `Map`, a typed
 * array, a Proxy that lies about its prototype): never the object itself. Spec refuses it
 * (`an object that is neither plain nor an array`), so the input or the rule is refused with its
 * pointer, and nothing the caller or a plugin holds reaches the engine.
 */
export class NotPlain {
  constructor(readonly description: string) {}
}
