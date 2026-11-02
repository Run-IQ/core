import { describe, it, expect } from 'vitest';
import {
  canonicalStringify,
  describeValue,
  findNonJson,
  isJsonValue,
} from '../../src/utils/json.js';
import { canonicalize, SpecError } from '@run-iq/spec';

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

  it('refuses an undefined array element, as spec does (it was written as null)', () => {
    expect(() => canonicalStringify([1, undefined, 3])).toThrow('[1] is not JSON: undefined');
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

describe('canonicalStringify delegates to @run-iq/spec canonicalize', () => {
  it('escapes a key containing a quote, giving valid JSON', () => {
    const out = canonicalStringify({ 'a"b': 1 });
    expect(out).toBe(canonicalize({ 'a"b': 1 }));
    expect(JSON.parse(out!)).toEqual({ 'a"b': 1 });
  });

  it.each([
    ['NaN', { v: NaN }],
    ['Infinity', { v: Infinity }],
    ['a Map', { v: new Map() }],
  ])('throws SpecError on %s', (_name, value) => {
    expect(() => canonicalStringify(value)).toThrow(SpecError);
  });
});

describe('isJsonValue', () => {
  it('accepts JSON data, including null-prototype objects', () => {
    const bare: Record<string, unknown> = Object.assign(Object.create(null), { a: [1, 'x'] });
    for (const value of [null, true, 'x', 0, -1.5, [], {}, { a: [null, { b: false }] }, bare]) {
      expect(isJsonValue(value)).toBe(true);
    }
  });

  it('refuses non-finite numbers, undefined, Dates, Maps, class instances and cycles', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    class Point {
      x = 1;
    }
    for (const value of [NaN, Infinity, undefined, new Date(0), new Map(), new Point(), cycle]) {
      expect(isJsonValue(value)).toBe(false);
    }
    expect(isJsonValue({ nested: [{ at: new Date(0) }] })).toBe(false);
  });

  it('accepts the same object twice when it is not a cycle', () => {
    const shared = { k: 1 };
    expect(isJsonValue([shared, shared, { again: shared }])).toBe(true);
  });
});

describe('findNonJson and describeValue', () => {
  it('names where a value stops being JSON', () => {
    const cycle: Record<string, unknown> = { list: [] };
    cycle['list'] = [cycle];
    expect(findNonJson({ ok: 1 })).toBeUndefined();
    expect(findNonJson(NaN)).toBe('$ (NaN)');
    expect(findNonJson({ a: { b: [1, undefined] } })).toBe('$.a.b[1] (undefined)');
    expect(findNonJson({ 'a-b': new Map() })).toBe('$["a-b"] (Map)');
    expect(findNonJson(cycle)).toBe('$.list[0] (cycle)');
  });

  it('describes any value without throwing', () => {
    expect([describeValue({ b: 1, a: 'x' }), describeValue(NaN), describeValue(-Infinity)]).toEqual(
      ['{"a":"x","b":1}', 'NaN', '-Infinity'],
    );
  });
});
