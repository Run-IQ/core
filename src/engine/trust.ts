import { AsyncLocalStorage } from 'node:async_hooks';

// Whether an error is the engine's own is decided by one thing: the engine raised it, during this
// call, and recorded it here. Class, brand, symbol and `instanceof` confer no trust: a constructor
// can make any of them, and a plugin can reach a constructor (from an error it was handed, from
// another engine of its own). The set belongs to one evaluation (or one construction), so an error
// raised by a nested engine, or in another evaluation, is not in it.

const calls = new AsyncLocalStorage<WeakSet<object>>();
/** For the code run outside an evaluation (a direct call of a reader). */
const outside = new WeakSet<object>();

/** Runs `fn` as one call of the engine: the errors it raises are its own and no one else's. */
export function inCall<T>(fn: () => T): T {
  return calls.run(new WeakSet<object>(), fn);
}

/** Records an error the engine raised itself, in this call, and returns it. */
export function raised<T extends object>(error: T): T {
  (calls.getStore() ?? outside).add(error);
  return error;
}

/** True only for an error the engine raised in this call. */
export function isRaised(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (calls.getStore() ?? outside).has(error);
}
