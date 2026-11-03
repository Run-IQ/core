// The port to plugin code: the only place where the engine calls a function a plugin gave, and
// where it reads a thrown value. Everything made by plugin code is touched here, in the reader
// (`reading`), or once at registration (`registering`), and nowhere else. A test (a plugin whose
// every object is a Proxy that logs each access) fails if the engine touches plugin data outside
// them.

import { markEngineError } from '../errors/engineError.js';

let readers = 0;
let registrations = 0;

/** True while the engine is reading or calling plugin data through the port. */
export function isReading(): boolean {
  return readers > 0;
}

/** True while a plugin, a model or a DSL is being registered (the one read of what it declares). */
export function isRegistering(): boolean {
  return registrations > 0;
}

/** Runs `fn` as the reader: an access to plugin data made inside it is the reader's. */
export function reading<T>(fn: () => T): T {
  readers += 1;
  try {
    return fn();
  } finally {
    readers -= 1;
  }
}

/** Runs `fn` as a registration: the one place a declaration of a plugin is read. */
export function registering<T>(fn: () => T): T {
  registrations += 1;
  try {
    return fn();
  } finally {
    registrations -= 1;
  }
}

/** What a plugin threw, held as text: no object of a plugin is kept. */
export interface PluginFault {
  /** At most 128 characters. */
  readonly name: string;
  /** At most 1 024 characters. */
  readonly message: string;
  /** At most 64 characters, when the thrown value had a string `code`. */
  readonly code?: string;
}

const MARKER = '... [clipped]';
const clipped = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}${MARKER}`;

/** The fault engine-built errors carry: made only here, so a brand set tells them from forgeries. */
const FAULTS = new WeakSet<object>();

/**
 * An error the port throws for a fault of plugin code. It is built by the engine and carries only
 * text; it is the only form in which anything thrown by plugin code travels inside the engine.
 */
export class PluginFaultError extends Error {
  readonly fault: PluginFault;

  constructor(fault: PluginFault) {
    super(fault.message !== '' ? fault.message : fault.name);
    this.name = 'PluginFaultError';
    this.fault = fault;
    FAULTS.add(this);
  }
}

markEngineError(PluginFaultError);

/** True for a fault the port built (a brand the engine alone sets). */
export function isPluginFault(value: unknown): value is PluginFaultError {
  return typeof value === 'object' && value !== null && FAULTS.has(value);
}

function property(value: object, key: string, max: number): string | undefined {
  try {
    const answer: unknown = (value as Record<string, unknown>)[key];
    return typeof answer === 'string' ? clipped(answer, max) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reduces a thrown value to text, read once: its `name` (128 characters), `message` (1 024) and,
 * when it has a string `code`, `code` (64), each cut with a visible marker. A string is a message.
 * Whatever its class or brand (an engine class included), a value thrown by plugin code is a plugin
 * fault.
 */
export function faultOf(thrown: unknown): PluginFault {
  return reading((): PluginFault => {
    if (isPluginFault(thrown)) return thrown.fault;
    if (typeof thrown === 'string') return { name: 'Error', message: clipped(thrown, 1024) };
    if ((typeof thrown === 'object' && thrown !== null) || typeof thrown === 'function') {
      const name = property(thrown, 'name', 128) ?? 'Error';
      const message = property(thrown, 'message', 1024) ?? '';
      const code = property(thrown, 'code', 64);
      return code === undefined ? { name, message } : { name, message, code };
    }
    let shown: string;
    try {
      shown = typeof thrown === 'symbol' ? thrown.toString() : String(thrown);
    } catch {
      shown = '(unprintable)';
    }
    return { name: 'Error', message: clipped(shown, 1024) };
  });
}

/**
 * A refusal the engine raises while it checks what a plugin returned (a malformed result, a hole,
 * a field it may not change). Built only by the engine's own checks.
 */
export class BoundaryError extends TypeError {}
markEngineError(BoundaryError);

/** A fault that is not a throw: the contract of a callback was broken. */
export function breach(message: string): PluginFaultError {
  return new PluginFaultError({ name: 'ContractError', message: clipped(message, 1024) });
}

/** The text of a fault, as one line: its message, or its name when it has none. */
export function describeFault(fault: PluginFault): string {
  return fault.message !== '' ? fault.message : fault.name;
}

type Fn = (...args: never[]) => unknown;

/** True for an object or a function with a `then` function (read once). Call inside the reader. */
function thenOf(value: unknown): Fn | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  const then: unknown = (value as { then?: unknown }).then;
  return typeof then === 'function' ? (then as Fn) : undefined;
}

/** Marks a thenable as handled, so that its rejection is never an unhandled one. */
function neutralize(value: unknown, then: Fn): void {
  try {
    Reflect.apply(then, value, [undefined, () => undefined]);
  } catch {
    // a thenable that throws is already a fault
  }
}

/**
 * Calls a function whose contract is synchronous. A throw is a plugin fault; so is a thenable
 * (`returned a promise`), which is never awaited and whose rejection is handled. `keep` names the
 * errors the engine raised itself during the call (a refused write into a view): they pass
 * through as they are.
 */
export function callSync(
  fn: Fn,
  thisArg: unknown,
  args: unknown[],
  keep?: (error: unknown) => boolean,
): unknown {
  return reading(() => {
    let result: unknown;
    try {
      result = Reflect.apply(fn, thisArg, args);
    } catch (error) {
      if (keep?.(error) === true) throw error;
      throw new PluginFaultError(faultOf(error));
    }
    let then: Fn | undefined;
    try {
      then = thenOf(result);
    } catch (error) {
      throw new PluginFaultError(faultOf(error));
    }
    if (then !== undefined) {
      neutralize(result, then);
      throw breach('returned a promise, which the contract of this callback does not allow');
    }
    return result;
  });
}

/**
 * Calls a function whose contract allows a promise (the hooks). The value, or the rejection, is
 * taken inside the reader, and the plugin's promise is never given to the engine's own promise
 * machinery: the engine resolves with a box, and a rejection is a `PluginFaultError`.
 */
export function callAsync(fn: Fn, thisArg: unknown, args: unknown[]): Promise<{ value: unknown }> {
  return new Promise((resolve, reject) => {
    reading(() => {
      let result: unknown;
      try {
        result = Reflect.apply(fn, thisArg, args);
      } catch (error) {
        reject(new PluginFaultError(faultOf(error)));
        return;
      }
      let then: Fn | undefined;
      try {
        then = thenOf(result);
      } catch (error) {
        reject(new PluginFaultError(faultOf(error)));
        return;
      }
      if (then === undefined) {
        resolve({ value: result });
        return;
      }
      try {
        Reflect.apply(then, result, [
          (value: unknown) => resolve({ value }),
          (error: unknown) => reject(new PluginFaultError(faultOf(error))),
        ]);
      } catch (error) {
        reject(new PluginFaultError(faultOf(error)));
      }
    });
  });
}

/**
 * A name the engine will keep: a string of 1 to 128 characters of letters, digits and `. _ - @ /`
 * (a scoped name such as `@run-iq/exception` is one), starting with a letter, a digit or `@`.
 */
export const NAME_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._@/-]{0,127}$/;
/** A version the engine will keep: semver (`1`, `1.0`, `1.0.0`, with a pre-release or build part). */
export const VERSION_PATTERN = /^\d+(\.\d+){0,2}([-+][0-9A-Za-z.+-]+)?$/;

/**
 * The identity of a plugin, a model or a DSL, read once at registration: a `name` and a `version`
 * that are strings of the shape above. The engine keeps these copies and never reads them from the
 * plugin again. Call inside `registering`. Throws `TypeError` naming the field.
 */
export function readIdentity(
  source: object,
  kind: 'plugin' | 'model' | 'DSL',
  nameKey: 'name' | 'dsl',
): { name: string; version: string } {
  const read = (key: string): unknown => (source as Record<string, unknown>)[key];
  const name = read(nameKey);
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new TypeError(
      `${kind} ${nameKey} must be a string of 1 to 128 characters of letters, digits and . _ - @ /, starting with a letter, a digit or @`,
    );
  }
  const version = read('version');
  if (typeof version !== 'string' || version.length > 64 || !VERSION_PATTERN.test(version)) {
    throw new TypeError(
      `${kind} ${name}: version must be a semver string of at most 64 characters`,
    );
  }
  return { name, version };
}
