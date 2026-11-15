import { types } from 'node:util';
import { EngineConfigError } from '../errors/EngineConfigError.js';
import { isEngineError } from '../errors/engineError.js';
import { describeFault, faultOf } from './pluginPort.js';

/**
 * The ONE inbound copier (AJ, structural ruling): every structured argument a caller passes is
 * copied here before any other code reads it, as the plugin side is copied by the reader. It
 * accepts plain objects and plain lists only, and reads own data properties by descriptor: an
 * accessor, a Proxy (any Proxy: it is told by `util.types.isProxy`, which runs no trap), a `Map`, a
 * `Set`, a `Date`, a class instance, a symbol key, a non-enumerable key, a hole, an extra key on a
 * list or an unknown key is refused with its path. Inherited values (and a polluted
 * `Object.prototype`) are never read. Nothing the caller holds runs after the copy.
 */
export type CallerShape =
  | { readonly kind: 'record'; readonly known?: readonly string[] | undefined }
  | { readonly kind: 'list'; readonly max?: number | undefined };

/** How a refusal is raised: by default an `EngineConfigError` with the path. */
export type Refuse = (path: string, reason: string) => Error;

const defaultRefuse: Refuse = (path, reason) => new EngineConfigError(path, reason);

const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const MAX_LIST = 100_000;

function child(path: string, key: string): string {
  return `${path === '/' ? '' : path}/${key}`;
}

export function copyCallerValue(
  value: unknown,
  path: string,
  shape: { readonly kind: 'record'; readonly known?: readonly string[] | undefined },
  refuse?: Refuse,
): Record<string, unknown>;
export function copyCallerValue(
  value: unknown,
  path: string,
  shape: { readonly kind: 'list'; readonly max?: number | undefined },
  refuse?: Refuse,
): unknown[];
export function copyCallerValue(
  value: unknown,
  path: string,
  shape: CallerShape,
  refuse: Refuse = defaultRefuse,
): Record<string, unknown> | unknown[] {
  try {
    if (typeof value !== 'object' || value === null) {
      throw refuse(path, shape.kind === 'list' ? 'must be a list' : 'must be an object');
    }
    if (types.isProxy(value)) throw refuse(path, 'must not be a Proxy');
    if (shape.kind === 'record' && Array.isArray(value)) throw refuse(path, 'must be an object');
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (shape.kind === 'list')
      return copyList(value, path, shape.max ?? MAX_LIST, prototype, refuse);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
      throw refuse(path, 'must be a plain object');
    }
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol')
        throw refuse(child(path, '(symbol)'), 'a symbol key is not allowed');
      const where = child(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!('value' in descriptor)) throw refuse(where, 'must be a data property, not an accessor');
      if (descriptor.enumerable !== true) throw refuse(where, 'must be enumerable');
      if (shape.known !== undefined && !shape.known.includes(key))
        throw refuse(where, 'unknown option');
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (error) {
    // What the engine itself refused is passed on; anything else (a trap of a hostile object) is
    // named, with the path, as bounded text. Identity decides, never `instanceof`.
    if (isEngineError(error)) throw error;
    throw refuse(path, `could not be read: ${describeFault(faultOf(error))}`);
  }
}

function copyList(
  value: object,
  path: string,
  max: number,
  prototype: unknown,
  refuse: Refuse,
): unknown[] {
  if (prototype !== ARRAY_PROTOTYPE || !Array.isArray(value))
    throw refuse(path, 'must be a plain list');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length =
    lengthDescriptor !== undefined && 'value' in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw refuse(path, 'has an invalid length');
  }
  if (length > max) throw refuse(path, `has more than ${max} items`);
  const keys = Reflect.ownKeys(value);
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const where = child(path, String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) throw refuse(where, 'is a hole');
    if (!('value' in descriptor)) throw refuse(where, 'must be a data property, not an accessor');
    if (descriptor.enumerable !== true) throw refuse(where, 'must be enumerable');
    copy.push(descriptor.value);
  }
  if (keys.length !== length + 1) {
    const extra = keys.find(
      (key) =>
        key !== 'length' &&
        !(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length),
    );
    throw refuse(
      child(path, typeof extra === 'symbol' ? '(symbol)' : String(extra)),
      'an extra key on a list is not allowed',
    );
  }
  return copy;
}

const dateTime = Date.prototype.getTime;
const MAX_COPY_DEPTH = 256;
const MAX_COPY_NODES = 2_000_000;

/**
 * The deep form of the copier, for the data a caller hands an exported helper (a rule, a meta,
 * the params of a hash): plain objects, plain lists, primitives and `Date`s, copied by descriptor,
 * with the same refusals (accessor, Proxy, `Map`, `Set`, class instance, symbol key, non-enumerable
 * key, hole, extra list key), a depth bound, a node bound and no cycle. The result is the engine's
 * own graph: nothing the caller holds is read again.
 */
export function copyCallerData(
  value: unknown,
  path: string,
  refuse: Refuse = defaultRefuse,
): unknown {
  const state = { nodes: 0 };
  const ancestors = new Set<object>();
  const walk = (current: unknown, where: string, depth: number): unknown => {
    if (typeof current === 'function' || typeof current === 'symbol') {
      throw refuse(where, `a ${typeof current} is not data`);
    }
    if (typeof current !== 'object' || current === null) return current;
    state.nodes += 1;
    if (state.nodes > MAX_COPY_NODES) throw refuse(where, 'is too large');
    if (depth > MAX_COPY_DEPTH) throw refuse(where, 'is nested too deeply');
    if (types.isProxy(current)) throw refuse(where, 'must not be a Proxy');
    if (ancestors.has(current)) throw refuse(where, 'is a cycle');
    if (types.isDate(current)) return new Date(Reflect.apply(dateTime, current, []) as number);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const list = copyCallerValue(current, where, { kind: 'list', max: MAX_COPY_NODES }, refuse);
        return list.map((item, index) => walk(item, child(where, String(index)), depth + 1));
      }
      const record = copyCallerValue(current, where, { kind: 'record' }, refuse);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        const copy = walk(record[key], child(where, key), depth + 1);
        Object.defineProperty(out, key, {
          value: copy,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    } finally {
      ancestors.delete(current);
    }
  };
  try {
    return walk(value, path, 0);
  } catch (error) {
    if (isEngineError(error)) throw error;
    throw refuse(path, `could not be read: ${describeFault(faultOf(error))}`);
  }
}
