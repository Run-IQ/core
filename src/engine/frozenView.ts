import { isDateObject } from '../utils/plain.js';
import { clip } from '../utils/frozenCopy.js';
import { FrozenViewWriteError } from '../errors/FrozenViewWriteError.js';

// The views the engine hands to models and DSLs. The engine's data is deep-frozen, so a write
// already fails in strict mode; but the failure would be a plain `TypeError`, indistinguishable
// from a `TypeError` of the model's own, and ignored in sloppy mode. A view traps the write itself
// and throws a dedicated error, so the rule that wrote is told apart by class, never by message.

/**
 * The views of one call into plugin code (one `calculate`, one `validateParams`, one
 * `listVariables`, one DSL evaluation). A write into a view is refused with a dedicated error,
 * and the scope notes the reason in a slot of its own, private to this call: when the call ends
 * with a throw and the slot is set, the rule that wrote is excluded with that reason. Nothing the
 * plugin can reach decides it: not the class, the identity or the content of what it throws.
 */
export class ViewScope {
  private readonly views = new WeakMap<object, object>();
  /** The reason of the first refused write of this call, or `undefined` if none was refused. */
  wrote: string | undefined;

  /**
   * A view of `value` that reads like the value and refuses every write, deeply and lazily. A
   * primitive is returned as it is. The same object always gives the same view within this
   * scope. Object identity is that of the view, not of the engine's object.
   */
  trapped<T>(value: T): T {
    if (typeof value !== 'object' || value === null) return value;
    return this.view(value) as T;
  }

  private refuse(key: string | symbol): never {
    const error = new FrozenViewWriteError(clip(typeof key === 'symbol' ? key.toString() : key));
    this.wrote ??= error.message;
    throw error;
  }

  /** What a view shows for a member: a view of an object, a copy of a `Date`, a primitive as is. */
  private show(member: unknown): unknown {
    if (typeof member !== 'object' || member === null) return member;
    // A `Date` is a fresh copy at each read: a reader that moves it moves nobody else's.
    return isDateObject(member)
      ? new Date(Date.prototype.getTime.call(member) as number)
      : this.view(member);
  }

  private view(real: object): object {
    return viewOf(this, real);
  }

  /** @internal */
  _known(real: object): object | undefined {
    return this.views.get(real);
  }

  /** @internal */
  _set(real: object, proxy: object): void {
    this.views.set(real, proxy);
  }

  /** @internal */
  _show(member: unknown): unknown {
    return this.show(member);
  }

  /** @internal */
  _refuse(key: string | symbol): never {
    return this.refuse(key);
  }
}

function viewOf(scope: ViewScope, real: object): object {
  const known = scope._known(real);
  if (known !== undefined) return known;
  const show = (member: unknown): unknown => scope._show(member);
  const refuse = (key: string | symbol): never => scope._refuse(key);
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
      // Only an existing property can be frozen: a new key on a closed stand-in is a write.
      if (freezing && Reflect.getOwnPropertyDescriptor(target, key) !== undefined) return true;
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
  scope._set(real, proxy);
  return proxy;
}
