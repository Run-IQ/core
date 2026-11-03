// The port to plugin code: the only place where the engine calls a function a plugin gave, and
// where it reads a thrown value. Everything made by plugin code is touched here, in the reader
// (`reading`), or once at registration (`registering`), and nowhere else. A test (a plugin whose
// every object is a Proxy that logs each trap) fails if the engine touches plugin data outside
// them.

import { types } from 'node:util';
import { markEngineError } from '../errors/engineError.js';
import { raised } from './trust.js';
import { clipText } from '../utils/weight.js';

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
/** `text` cut to `max` characters on a code point, with the marker, and well-formed. */
const clipped = (text: string, max: number): string => clipText(text, max, MARKER);

/** A text that came from plugin code, as the record may hold it: 1 024 characters, well-formed. */
export function clipFault(text: string): string {
  return clipped(text, 1024);
}

/** The text of each fault the port made. Not a property of the error: nothing reads it back from one. */
const FAULT_TEXT = new WeakMap<object, PluginFault>();

/**
 * An error the port raises for a fault of plugin code. Only the factories below make one that the
 * engine trusts: the constructor is not enough (a plugin that reaches this class builds an object
 * the engine does not know).
 */
export class PluginFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginFaultError';
  }
}
markEngineError(PluginFaultError);

/** A fault of plugin code, as text, raised by the engine in this call. */
export function faultError(fault: PluginFault): PluginFaultError {
  const frozen: PluginFault = Object.freeze({ ...fault });
  const error = new PluginFaultError(describeFault(frozen));
  FAULT_TEXT.set(error, frozen);
  return Object.freeze(raised(error));
}

/** The text of a fault the engine raised in this call; `undefined` for anything else. */
export function trustedFault(value: unknown): PluginFault | undefined {
  return isPluginFault(value) ? FAULT_TEXT.get(value) : undefined;
}

/** True only for a fault the engine raised in this call (never by class or by a field). */
export function isPluginFault(value: unknown): value is PluginFaultError {
  return typeof value === 'object' && value !== null && FAULT_TEXT.has(value);
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
 * when it has a string `code`, `code` (64), each cut on a code point with a visible marker. A
 * string is a message. Whatever its class or brand (an engine class included, a fault the engine
 * did not raise in this call included), a value thrown by plugin code is a plugin fault.
 */
export function faultOf(thrown: unknown): PluginFault {
  return reading((): PluginFault => {
    if (isPluginFault(thrown)) return FAULT_TEXT.get(thrown) as PluginFault;
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

/** The fault of a thrown value, as an error the engine raised. */
export function faultFrom(thrown: unknown): PluginFaultError {
  return isPluginFault(thrown) ? thrown : faultError(faultOf(thrown));
}

/**
 * A refusal the engine raises while it checks what a plugin returned (a malformed result, a hole,
 * a field it may not change). Recorded as raised by the engine in this call.
 */
export class BoundaryError extends TypeError {}
markEngineError(BoundaryError);

/** A refusal raised by the engine, in this call. */
export function refusal(message: string): BoundaryError {
  return Object.freeze(raised(new BoundaryError(message)));
}

/** A fault that is not a throw: the contract of a callback was broken. */
export function breach(message: string): PluginFaultError {
  return faultError({ name: 'ContractError', message: clipped(message, 1024) });
}

/** The text of a fault, as one line: its message, or its name when it has none. */
export function describeFault(fault: PluginFault): string {
  return fault.message !== '' ? fault.message : fault.name;
}

type Fn = (...args: never[]) => unknown;

// The intrinsics the port adopts a promise with, captured when this module loads (before any
// plugin): never the `then` or the `constructor` of the value itself.
const promiseThen = Promise.prototype.then;
const noop = (): void => undefined;

/** True for a thenable that is not a native promise: an object or function with a `then` function. */
function thenOf(value: unknown): Fn | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  const then: unknown = (value as { then?: unknown }).then;
  return typeof then === 'function' ? (then as Fn) : undefined;
}

/**
 * Marks a promise or thenable the engine will not use as handled, so that its rejection is never
 * an unhandled one. A native promise (a subclass included) is handled through the captured
 * `Promise.prototype.then`, never its own `then`.
 */
export function neutralize(value: unknown): void {
  reading(() => {
    try {
      if (types.isPromise(value)) {
        Reflect.apply(promiseThen, value, [undefined, noop]);
        return;
      }
      const then = thenOf(value);
      if (then !== undefined) Reflect.apply(then, value, [undefined, noop]);
    } catch {
      // a thenable that throws is already a fault; a Proxy over a promise cannot be reached
    }
  });
}

/**
 * Calls a function whose contract is synchronous. A throw is a plugin fault; so is a thenable
 * (`returned a promise`), which is never awaited and whose rejection is handled. Whatever it
 * throws, an engine error included, is a fault: the engine tells a refused write by the slot of
 * the view scope, never by what was thrown.
 */
export function callSync(fn: Fn, thisArg: unknown, args: unknown[]): unknown {
  return reading(() => {
    let result: unknown;
    try {
      result = Reflect.apply(fn, thisArg, args);
    } catch (error) {
      throw faultFrom(error);
    }
    let promising: boolean;
    try {
      promising = types.isPromise(result) || thenOf(result) !== undefined;
    } catch (error) {
      throw faultFrom(error);
    }
    if (promising) {
      neutralize(result);
      throw breach('returned a promise, which the contract of this callback does not allow');
    }
    return result;
  });
}

/**
 * Calls a function whose contract allows a promise (the hooks). The value, or the rejection, is
 * taken inside the reader, and a plugin's promise is never given to the engine's own promise
 * machinery: a native promise is adopted through the captured `Promise.prototype.then`, any other
 * thenable through its `then` called here, in the reader; the engine resolves with a box, and a
 * rejection is a fault. A promise found as the resolved value is handled too.
 */
export function callAsync(fn: Fn, thisArg: unknown, args: unknown[]): Promise<{ value: unknown }> {
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => reject(faultFrom(error));
    const done = (value: unknown): void => {
      reading(() => {
        // A promise as a value is not one the engine will await: it is handled and left.
        neutralize(value);
      });
      resolve({ value });
    };
    reading(() => {
      let result: unknown;
      try {
        result = Reflect.apply(fn, thisArg, args);
      } catch (error) {
        fail(error);
        return;
      }
      try {
        if (types.isPromise(result)) {
          Reflect.apply(promiseThen, result, [done, fail]);
          return;
        }
        const then = thenOf(result);
        if (then === undefined) {
          resolve({ value: result });
          return;
        }
        Reflect.apply(then, result, [done, fail]);
      } catch (error) {
        fail(error);
      }
    });
  });
}

/**
 * A name the engine will keep for a plugin or a DSL: lower case, 1 to 128 characters, words of
 * letters and digits joined by one `.`, `_` or `-`.
 */
export const NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
/**
 * A name the engine will keep for a model: an optional scope `@scope/`, then the name of a plugin,
 * in lower case only (`flat-rate`, `@run-iq/exception`).
 */
export const MODEL_NAME_PATTERN =
  /^(?:@[a-z0-9]+(?:[._-][a-z0-9]+)*\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
/** The official SemVer 2.0.0 expression. */
export const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * The identity of a plugin, a model or a DSL, read once at registration: a `name` (at most 128
 * characters, of the shape above) and a `version` (SemVer 2.0.0, at most 64 characters). The engine
 * keeps these copies and never reads them from the plugin again. Call inside `registering`. Throws
 * `TypeError` naming the field.
 */
export function readIdentity(
  source: object,
  kind: 'plugin' | 'model' | 'DSL',
  nameKey: 'name' | 'dsl',
): { name: string; version: string } {
  const read = (key: string): unknown => (source as Record<string, unknown>)[key];
  const name = read(nameKey);
  const fits =
    typeof name === 'string' &&
    name.length <= 128 &&
    (kind === 'model' ? MODEL_NAME_PATTERN.test(name) : NAME_PATTERN.test(name));
  if (!fits) {
    throw new TypeError(
      kind === 'model'
        ? `model ${nameKey} must be 1 to 128 characters: letters and digits, joined by single . _ or -`
        : `${kind} ${nameKey} must be 1 to 128 characters: lower-case letters and digits, joined by single . _ or -`,
    );
  }
  const version = read('version');
  if (typeof version !== 'string' || version.length > 64 || !VERSION_PATTERN.test(version)) {
    throw new TypeError(
      `${kind} ${name}: version must be a SemVer 2.0.0 string of at most 64 characters`,
    );
  }
  return { name, version };
}
