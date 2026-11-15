// There is no trust set. An error is never the engine's own because it was recorded somewhere, or
// because of its class: whatever comes out of a plugin frame is a fault of the plugin, whoever
// caused the engine to raise it (an engine function the plugin called included).
//
// The one place that lets an engine error through a plugin frame is `guarded`, and it decides by
// a set that lives only for that read, in a closure: the walker it runs raises its own refusals
// and limits into it, and nothing else can. A function the engine exports (`readsOf`, a registry,
// a nested engine) runs `isolated`: what it raises goes to no read in progress, so a plugin that
// calls it from a getter and throws the error again throws a fault.

let active: WeakSet<object> | null = null;

/** Notes an error the engine raises for the read in progress (a no-op outside one). */
export function raised<T extends object>(error: T): T {
  active?.add(error);
  return error;
}

/**
 * Runs `fn` as a read: the errors it raises through `raised` pass, anything else that is thrown is
 * given to `foreign`, which makes the fault of it. The set is dropped when the read ends; an error
 * that passes is noted for the read around this one.
 */
export function ownRead<T>(fn: () => T, foreign: (thrown: unknown) => never): T {
  const outer = active;
  const mine = new WeakSet<object>();
  active = mine;
  try {
    return fn();
  } catch (thrown) {
    active = outer;
    if (typeof thrown === 'object' && thrown !== null && mine.has(thrown)) {
      outer?.add(thrown);
      throw thrown;
    }
    return foreign(thrown);
  } finally {
    active = outer;
  }
}

/** Starts an isolated stretch of code; the function it returns ends it. */
export function isolate(): () => void {
  const outer = active;
  active = null;
  return () => {
    active = outer;
  };
}

/** Runs `fn` so that what it raises is noted for no read in progress. */
export function isolated<T>(fn: () => T): T {
  const outer = active;
  active = null;
  try {
    return fn();
  } finally {
    active = outer;
  }
}
