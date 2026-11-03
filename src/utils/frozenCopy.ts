import { isEngineErrorPrototype } from '../errors/engineError.js';
import { clipText } from './weight.js';

/** Nodes of one copy; past it the rest is a marker. */
const MAX_NODES = 1000;
/** Characters of one string in a copy; a longer one is cut, with its length said. */
const MAX_TEXT = 1024;
/** Levels of one copy. */
const MAX_DEPTH = 16;

const INTRINSIC_ERRORS: ReadonlySet<unknown> = new Set([
  Error.prototype,
  TypeError.prototype,
  RangeError.prototype,
  SyntaxError.prototype,
  ReferenceError.prototype,
  EvalError.prototype,
  URIError.prototype,
]);

/**
 * `text` as it is, or cut to `MAX_TEXT` characters on a code point with its length. Always
 * well-formed: a lone surrogate is replaced, whatever the length, so that no text the engine
 * writes into a record or an error can hold one.
 */
export function clip(text: string): string {
  return clipText(text, MAX_TEXT, `... (${text.length} characters)`);
}

interface State {
  nodes: number;
  readonly seen: Map<object, unknown>;
}

/**
 * An engine-owned, deep-frozen copy of a thrown value, for a plugin that is told of a failure and
 * for the `cause` of an error the caller receives. Nothing a plugin holds is kept:
 * - the copy is bounded (1 000 nodes, 16 levels, strings of at most 1 024 characters) and safe on
 *   cycles;
 * - an error keeps the prototype of the language's own error classes and of the engine's, and any
 *   other prototype becomes `Error.prototype`: no code of a plugin runs when the caller reads or
 *   prints it;
 * - `name`, `message` and `stack` are read once, as strings, into own data properties, so a getter
 *   or a later change to a prototype does not rewrite them;
 * - a function, a `Date`, a class instance and anything else that is not plain data is described
 *   by a string.
 */
export function frozenErrorCopy(value: unknown): unknown {
  return copy(value, 0, { nodes: 0, seen: new Map() });
}

function describe(value: object): string {
  try {
    const ctor: unknown = (Object.getPrototypeOf(value) as { constructor?: unknown } | null)
      ?.constructor;
    const name = typeof ctor === 'function' && ctor.name !== '' ? ctor.name : 'Object';
    return clip(`[object ${name}]`);
  } catch {
    return '[unreadable]';
  }
}

function copy(value: unknown, depth: number, state: State): unknown {
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'function') {
    let name = '';
    try {
      const given: unknown = value.name;
      if (typeof given === 'string') name = given;
    } catch {
      // an unreadable name
    }
    return clip(`[Function: ${name}]`);
  }
  if (typeof value !== 'object' || value === null) return value;
  const known = state.seen.get(value);
  if (known !== undefined) return known;
  state.nodes += 1;
  if (state.nodes > MAX_NODES) return '[truncated]';
  if (depth > MAX_DEPTH) return '[too deep]';
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      state.seen.set(value, out);
      const length = Math.min(value.length, MAX_NODES);
      for (let index = 0; index < length; index += 1) {
        out.push(copy(value[index], depth + 1, state));
      }
      if (value.length > length) out.push('[truncated]');
      return Object.freeze(out);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    const isError = value instanceof Error;
    const plain = prototype === null || prototype === Object.prototype;
    if (!isError && !plain) return describe(value);
    const keep = isError && (INTRINSIC_ERRORS.has(prototype) || isEngineErrorPrototype(prototype));
    const out: object = Object.create(
      isError ? (keep ? (prototype as object) : Error.prototype) : (prototype as object | null),
    );
    state.seen.set(value, out);
    const define = (key: string | symbol, item: unknown, enumerable: boolean): void => {
      Object.defineProperty(out, key, {
        value: item,
        enumerable,
        writable: false,
        configurable: false,
      });
    };
    if (isError) {
      // Read once, here: a getter answers once and a later change shows nowhere.
      for (const key of ['name', 'message', 'stack'] as const) {
        let item: unknown;
        try {
          item = (value as unknown as Record<string, unknown>)[key];
        } catch {
          item = '[unreadable]';
        }
        if (typeof item === 'string') define(key, clip(item), false);
      }
    }
    for (const key of Reflect.ownKeys(value)) {
      if (isError && (key === 'name' || key === 'message' || key === 'stack')) continue;
      state.nodes += 1;
      if (state.nodes > MAX_NODES) {
        define('[truncated]', true, false);
        break;
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      define(key, copy(descriptor.value, depth + 1, state), descriptor.enumerable === true);
    }
    return Object.freeze(out);
  } catch {
    return '[unreadable]';
  }
}
