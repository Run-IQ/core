import { describe, it, expect } from 'vitest';
import type { JsonValue } from '@run-iq/spec';
import { deepMerge } from '../../src/utils/deepMerge.js';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value) as unknown[]) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('deepMerge', () => {
  it('merges objects recursively and replaces arrays and scalars', () => {
    const base = { rate: 0.5, brackets: [1, 2, 3], opts: { a: 1, b: { c: 2 } } };
    const patch: { [k: string]: JsonValue } = {
      rate: 0.1,
      brackets: [9],
      opts: { b: { d: 3 } },
    };
    expect(deepMerge(base, patch)).toEqual({
      rate: 0.1,
      brackets: [9],
      opts: { a: 1, b: { c: 2, d: 3 } },
    });
  });

  it('replaces an object by a scalar and a scalar by an object', () => {
    expect(deepMerge({ a: { x: 1 }, b: 2 }, { a: 3, b: { y: 4 } })).toEqual({
      a: 3,
      b: { y: 4 },
    });
  });

  it('starts from an empty object when the base is not an object', () => {
    expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge([1, 2], { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge(null, { a: 1 })).toEqual({ a: 1 });
  });

  it('never mutates its inputs, even frozen, and does not share the patch values', () => {
    const base = deepFreeze({ opts: { a: 1 }, list: [1] });
    const patch = deepFreeze({ opts: { b: 2 }, list: [2, 3] });
    const merged = deepMerge(base, patch);
    expect(merged).toEqual({ opts: { a: 1, b: 2 }, list: [2, 3] });
    expect(base).toEqual({ opts: { a: 1 }, list: [1] });
    expect(patch).toEqual({ opts: { b: 2 }, list: [2, 3] });
    const list = (merged as { list: number[] }).list;
    expect(list).not.toBe(patch.list);
    expect(Object.isFrozen(list)).toBe(false);
  });

  it('keeps __proto__, constructor and prototype as own data keys without polluting prototypes', () => {
    const patch = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"nested":{"__proto__":{"polluted":true}}}',
    ) as { [k: string]: JsonValue };
    const merged = deepMerge({ nested: { keep: 1 } }, patch) as Record<string, unknown>;

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual({
      polluted: true,
    });
    expect(Object.hasOwn(merged, 'constructor')).toBe(true);
    expect(merged.prototype).toEqual({ polluted: true });
    const nested = merged.nested as Record<string, unknown>;
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(nested.keep).toBe(1);
    expect(nested.polluted).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(nested, '__proto__')?.value).toEqual({
      polluted: true,
    });
  });

  it('does not merge into the inherited prototype when the base lacks an own __proto__', () => {
    const patch = JSON.parse('{"__proto__":{"a":1}}') as { [k: string]: JsonValue };
    const merged = deepMerge({}, patch) as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual({ a: 1 });
  });
});
