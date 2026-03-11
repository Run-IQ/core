import { describe, it, expect } from 'vitest';
import { canonicalStringify } from '../../src/utils/json.js';

describe('canonicalStringify', () => {
  it('returns undefined for undefined', () => {
    expect(canonicalStringify(undefined)).toBeUndefined();
  });

  it('returns "null" for null', () => {
    expect(canonicalStringify(null)).toBe('null');
  });

  it('serializes a string primitive', () => {
    expect(canonicalStringify('hello')).toBe('"hello"');
  });

  it('serializes a number primitive', () => {
    expect(canonicalStringify(42)).toBe('42');
  });

  it('serializes a boolean primitive', () => {
    expect(canonicalStringify(true)).toBe('true');
    expect(canonicalStringify(false)).toBe('false');
  });

  it('sorts object keys alphabetically', () => {
    const result = canonicalStringify({ b: 2, a: 1 });
    expect(result).toBe('{"a":1,"b":2}');
  });

  it('sorts keys in nested objects', () => {
    const result = canonicalStringify({ z: { b: 2, a: 1 }, a: 0 });
    expect(result).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  it('serializes arrays preserving order', () => {
    const result = canonicalStringify([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('serializes arrays with nested objects', () => {
    const result = canonicalStringify([{ b: 1, a: 2 }]);
    expect(result).toBe('[{"a":2,"b":1}]');
  });

  it('excludes undefined values from objects', () => {
    const result = canonicalStringify({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it('converts undefined array elements to null', () => {
    const result = canonicalStringify([1, undefined, 3]);
    expect(result).toBe('[1,null,3]');
  });

  it('returns "{}" for empty object', () => {
    expect(canonicalStringify({})).toBe('{}');
  });

  it('returns "[]" for empty array', () => {
    expect(canonicalStringify([])).toBe('[]');
  });

  it('serializes Date objects as ISO strings', () => {
    const date = new Date('2025-06-15T10:30:00.000Z');
    const result = canonicalStringify(date);
    expect(result).toBe('"2025-06-15T10:30:00.000Z"');
  });

  it('serializes objects containing Date values', () => {
    const result = canonicalStringify({ d: new Date('2025-01-01T00:00:00.000Z'), a: 1 });
    expect(result).toBe('{"a":1,"d":"2025-01-01T00:00:00.000Z"}');
  });

  it('is deterministic across multiple calls', () => {
    const obj = { z: [1, { b: 2, a: 1 }], a: 'hello' };
    const r1 = canonicalStringify(obj);
    const r2 = canonicalStringify(obj);
    const r3 = canonicalStringify(obj);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });
});
