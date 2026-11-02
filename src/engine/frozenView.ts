import { isDateObject } from '../utils/plain.js';
import { FrozenViewWriteError } from '../errors/FrozenViewWriteError.js';

// The views the engine hands to models and DSLs. The engine's data is deep-frozen, so a write
// already fails in strict mode; but the failure would be a plain `TypeError`, indistinguishable
// from a `TypeError` of the model's own, and ignored in sloppy mode. A view traps the write itself
// and throws a dedicated error, so the rule that wrote is told apart by class, never by message.

const VIEWS = new WeakMap<object, object>();

/** The copy of a `Date` a view shows: a Proxy over a `Date` cannot call its methods. */
const DATES = new WeakMap<object, Date>();

function dateView(real: object): Date {
  const known = DATES.get(real);
  if (known !== undefined) return known;
  const copy = new Date(Date.prototype.getTime.call(real) as number);
  DATES.set(real, copy);
  return copy;
}

/** What a view shows for a member: a view of an object, a copy of a `Date`, a primitive as is. */
function show(member: unknown): unknown {
  if (typeof member !== 'object' || member === null) return member;
  return isDateObject(member) ? dateView(member) : view(member);
}

const refuse = (key: string | symbol): never => {
  throw new FrozenViewWriteError(typeof key === 'symbol' ? key.toString() : key);
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
    get(_target, key) {
      return show(Reflect.get(real, key));
    },
    has: (_target, key) => Reflect.has(real, key),
    ownKeys: () => Reflect.ownKeys(real),
    getOwnPropertyDescriptor(_target, key) {
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
    defineProperty: (_target, key) => refuse(key),
    deleteProperty: (_target, key) => refuse(key),
    setPrototypeOf: () => refuse('(prototype)'),
    preventExtensions: () => refuse('(extensible)'),
  });
  VIEWS.set(real, proxy);
  return proxy;
}
