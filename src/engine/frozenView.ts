import { isDateObject } from '../utils/plain.js';
import { FrozenViewWriteError } from '../errors/FrozenViewWriteError.js';

// The views the engine hands to models and DSLs. The engine's data is deep-frozen, so a write
// already fails in strict mode; but the failure would be a plain `TypeError`, indistinguishable
// from a `TypeError` of the model's own, and ignored in sloppy mode. A view traps the write itself
// and throws a dedicated error, so the rule that wrote is told apart by class, never by message.

const VIEWS = new WeakMap<object, object>();

/** What a view shows for a member: a view of an object, a copy of a `Date`, a primitive as is. */
function show(member: unknown): unknown {
  if (typeof member !== 'object' || member === null) return member;
  // A `Date` is a fresh copy at each read: a reader that moves it moves nobody else's.
  return isDateObject(member)
    ? new Date(Date.prototype.getTime.call(member) as number)
    : view(member);
}

/**
 * The errors the views threw: an error is recognised as a refused write by being in this set,
 * never by its class, which any code can construct.
 */
const VIEW_ERRORS = new WeakSet<object>();

/** True for an error a view threw for a write (not one that merely looks like it). */
export function isViewWriteError(error: unknown): error is FrozenViewWriteError {
  return typeof error === 'object' && error !== null && VIEW_ERRORS.has(error);
}

const refuse = (key: string | symbol): never => {
  const error = new FrozenViewWriteError(typeof key === 'symbol' ? key.toString() : key);
  VIEW_ERRORS.add(error);
  throw error;
};

/**
 * A view of `value` that reads like the value and refuses every write, deeply and lazily. A
 * primitive is returned as it is. The same object always gives the same view. Object identity
 * is that of the view, not of the engine's object.
 */
export function trapped<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  return view(value) as T;
}

function view(real: object): object {
  const known = VIEWS.get(real);
  if (known !== undefined) return known;
  // The target is an empty stand-in: the invariants of a Proxy are about its target, and a frozen
  // target would force every read to return the very same object.
  const isList = Array.isArray(real);
  const proxy = new Proxy(isList ? [] : {}, {
    get(target, key) {
      if (!Object.isExtensible(target)) return Reflect.get(target, key);
      return show(Reflect.get(real, key));
    },
    has: (_target, key) => Reflect.has(real, key),
    ownKeys: () => Reflect.ownKeys(real),
    getOwnPropertyDescriptor(target, key) {
      if (!Object.isExtensible(target)) return Reflect.getOwnPropertyDescriptor(target, key);
      const descriptor = Reflect.getOwnPropertyDescriptor(real, key);
      if (descriptor === undefined) return undefined;
      if ('value' in descriptor) {
        const shown = show(descriptor.value);
        // A list's `length` is non-configurable on the stand-in: it is reported as it is there.
        if (isList && key === 'length') {
          return { value: shown, writable: true, enumerable: false, configurable: false };
        }
        return {
          value: shown,
          writable: false,
          enumerable: descriptor.enumerable === true,
          configurable: true,
        };
      }
      return { ...descriptor, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(real),
    set: (_target, key) => refuse(key),
    defineProperty(target, key, descriptor) {
      // The second half of `Object.freeze(view)`: marking an existing property non-configurable
      // or non-writable, which it already is. Anything else is a write.
      const freezing =
        !Object.isExtensible(target) &&
        Object.keys(descriptor).every(
          (field) =>
            (field === 'configurable' && descriptor.configurable === false) ||
            (field === 'writable' && descriptor.writable === false),
        );
      if (freezing) return true;
      return refuse(key);
    },
    deleteProperty: (_target, key) => refuse(key),
    setPrototypeOf: () => refuse('(prototype)'),
    // `Object.freeze(view)` and `Object.preventExtensions(view)` are not writes: the data is frozen
    // already. The stand-in is made to hold every property of the real object, as a frozen one
    // would (a non-extensible target may not report a key it lacks), then closed; reads after that
    // are the stand-in's, which a frozen property must answer with its own value.
    preventExtensions(target) {
      for (const key of Reflect.ownKeys(real)) {
        if (isList && key === 'length') continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(real, key);
        if (descriptor === undefined || !('value' in descriptor)) continue;
        Object.defineProperty(target, key, {
          value: show(descriptor.value),
          writable: false,
          enumerable: descriptor.enumerable === true,
          configurable: false,
        });
      }
      if (isList) Object.defineProperty(target, 'length', { writable: false });
      Object.preventExtensions(target);
      return true;
    },
  });
  VIEWS.set(real, proxy);
  return proxy;
}
