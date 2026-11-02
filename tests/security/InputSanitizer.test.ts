import { describe, it, expect } from 'vitest';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { resolveLimits } from '../../src/limits.js';
import type { EngineLimits } from '../../src/limits.js';

describe('InputSanitizer', () => {
  it('accepts valid input', () => {
    expect(() =>
      InputSanitizer.validate({
        requestId: 'req-1',
        data: { amount: 100 },
        meta: { tenantId: 'tenant-1' },
      }),
    ).not.toThrow();
  });

  it('rejects null input', () => {
    expect(() => InputSanitizer.validate(null)).toThrow(ValidationError);
  });

  it('rejects missing requestId', () => {
    expect(() =>
      InputSanitizer.validate({
        data: {},
        meta: { tenantId: 't' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects empty requestId', () => {
    expect(() =>
      InputSanitizer.validate({
        requestId: '',
        data: {},
        meta: { tenantId: 't' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects missing data', () => {
    expect(() =>
      InputSanitizer.validate({
        requestId: 'r',
        meta: { tenantId: 't' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects missing meta.tenantId', () => {
    expect(() =>
      InputSanitizer.validate({
        requestId: 'r',
        data: {},
        meta: {},
      }),
    ).toThrow(ValidationError);
  });

  it('includes reasons in validation error', () => {
    try {
      InputSanitizer.validate({});
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).reasons.length).toBeGreaterThan(0);
    }
  });

  it('rejects __proto__ key in data', () => {
    // Use JSON.parse to create a literal __proto__ key (object literal syntax sets prototype instead)
    const maliciousInput = JSON.parse(
      '{"requestId":"r","data":{"__proto__":{"polluted":true}},"meta":{"tenantId":"t"}}',
    ) as unknown;
    expect(() => InputSanitizer.validate(maliciousInput)).toThrow(ValidationError);
  });

  it('rejects constructor key in data', () => {
    expect(() =>
      InputSanitizer.validate({
        requestId: 'r',
        data: { constructor: 'evil' },
        meta: { tenantId: 't' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects prototype key in meta', () => {
    expect(() =>
      InputSanitizer.validate({
        requestId: 'r',
        data: {},
        meta: { tenantId: 't', prototype: {} },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects __proto__ key in meta', () => {
    // Use JSON.parse to create a literal __proto__ key
    const maliciousInput = JSON.parse(
      '{"requestId":"r","data":{},"meta":{"tenantId":"t","__proto__":{"polluted":true}}}',
    ) as unknown;
    expect(() => InputSanitizer.validate(maliciousInput)).toThrow(ValidationError);
  });

  describe('the canonical input (spec validateProofInput)', () => {
    const DATE_MESSAGE =
      'a reference date must be a Date, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS[.sss] with Z or ±HH:MM, in the years 0000 to 9999; got';
    const input = (data: Record<string, unknown>, meta: Record<string, unknown> = {}): unknown => ({
      requestId: 'req-1',
      data,
      meta: { tenantId: 't', ...meta },
    });
    const reasonsOf = (value: unknown): readonly string[] => {
      try {
        InputSanitizer.validate(value);
      } catch (error) {
        if (error instanceof ValidationError) {
          expect(error.message).toBe('Invalid evaluation input');
          return error.reasons;
        }
        throw error;
      }
      return expect.unreachable('should have thrown');
    };

    it('refuses a misspelled or extra meta key, as spec words it', () => {
      expect(reasonsOf(input({}, { effectivedate: new Date('2024-01-01') }))).toEqual([
        '/meta has an unknown key "effectivedate"',
      ]);
      expect(reasonsOf(input({}, { date: '2024-01-01', extra: 1 }))).toEqual([
        '/meta has an unknown key "date"',
        '/meta has an unknown key "extra"',
      ]);
    });

    it('refuses userId, which the canonical meta does not define', () => {
      expect(reasonsOf(input({}, { userId: 'u' }))).toEqual(['/meta has an unknown key "userId"']);
    });

    it('keeps a date or a dimension named __proto__ as an own key, never dropped', () => {
      const prepare = (text: string) =>
        InputSanitizer.prepare({ requestId: 'req-1', data: {}, meta: JSON.parse(text) });
      const dates = prepare('{"tenantId":"t","dates":{"__proto__":"2026-01-01"}}').meta.dates;
      expect(Object.keys(dates)).toEqual(['__proto__']);
      expect(Object.getOwnPropertyDescriptor(dates, '__proto__')?.value).toBe('2026-01-01');
      expect(Object.getPrototypeOf(dates)).toBe(Object.prototype);
      const one = prepare('{"tenantId":"t","dimensions":{"__proto__":"FR"}}').meta.dimensions;
      expect(Object.getOwnPropertyDescriptor(one, '__proto__')?.value).toBe('FR');
      const many = prepare('{"tenantId":"t","dimensions":{"__proto__":["US","FR","US"]}}').meta
        .dimensions;
      expect(Object.getOwnPropertyDescriptor(many, '__proto__')?.value).toEqual(['FR', 'US']);
      expect(Object.getPrototypeOf(many)).toBe(Object.prototype);
    });

    it('does not count an unknown meta key whose value is undefined', () => {
      expect(() => InputSanitizer.validate(input({}, { date: undefined }))).not.toThrow();
    });

    it('still accepts every key the evaluation input defines', () => {
      expect(() =>
        InputSanitizer.validate(
          input(
            {},
            {
              effectiveDate: new Date('2024-01-01'),
              dates: { facture: '2024-02-01' },
              tags: ['a'],
              dimensions: { country: 'TG' },
              context: { k: 1 },
              assertions: {},
            },
          ),
        ),
      ).not.toThrow();
    });

    it('refuses a root key of data that starts with $', () => {
      expect(reasonsOf(input({ $outputs: 1, $x: 2, fine: 3 }))).toEqual([
        'reserved key /data/$outputs',
        'reserved key /data/$x',
      ]);
    });

    it('refuses a number of 2^53 or more, at its pointer', () => {
      expect(reasonsOf(input({ a: [1, 2 ** 53] }))).toEqual(['number beyond 2^53 at /data/a/1']);
      expect(reasonsOf(input({ x: 1e300 }))).toEqual(['number beyond 2^53 at /data/x']);
      expect(() => InputSanitizer.validate(input({ a: [1, 2 ** 53 - 1] }))).not.toThrow();
    });

    it('refuses a lone UTF-16 surrogate in a key', () => {
      expect(reasonsOf(input({ ['a\ud800']: 1 }))).toEqual([
        '/data has a key with a lone UTF-16 surrogate: "a\\ud800"',
      ]);
    });

    it('refuses a date that is not a date, and an effectiveDate that differs from dates.effective', () => {
      expect(reasonsOf(input({}, { dates: { effective: '2026-13-01' } }))).toEqual([
        `meta.dates.effective: ${DATE_MESSAGE} "2026-13-01"`,
      ]);
      expect(
        reasonsOf(
          input(
            {},
            { effectiveDate: new Date('2026-01-01T00:00:00Z'), dates: { effective: '2026-01-02' } },
          ),
        ),
      ).toEqual(['meta.effectiveDate and meta.dates.effective differ']);
    });

    it('refuses an invalid assertion with the messages of spec', () => {
      expect(reasonsOf(input({}, { assertions: { '/a': { nope: 1 } } }))).toEqual([
        '/meta/assertions/~1a has an unknown key "nope"',
        '/meta/assertions/~1a/by is required',
        '/meta/assertions/~1a/method is required',
        '/meta/assertions/~1a/at is required',
        '/meta/assertions/~1a/status is required',
      ]);
    });

    it('refuses an empty list of dimension values', () => {
      expect(reasonsOf(input({}, { dimensions: { k: [] } }))).toEqual([
        '/meta/dimensions/k must not be an empty list',
      ]);
    });

    it('names a member of the meta that has the wrong type, never crashing on it', () => {
      expect(reasonsOf(input({}, { dates: 'x' }))).toEqual(['/meta/dates must be a plain object']);
      expect(reasonsOf(input({}, { tags: 'abc' }))).toEqual([
        '/meta/tags must be an array of strings',
      ]);
      expect(reasonsOf(input({}, { dimensions: ['a'] }))).toEqual([
        '/meta/dimensions must be a plain object',
      ]);
      expect(reasonsOf(input({}, { dimensions: { k: 3 } }))).toEqual([
        '/meta/dimensions/k must be a value or a sorted list of at least two values',
      ]);
      expect(reasonsOf(input({}, { context: [] }))).toEqual([
        '/meta/context must be a plain object',
      ]);
      expect(reasonsOf(input({}, { context: null }))).toEqual([
        '/meta/context must be a plain object',
      ]);
      expect(reasonsOf(input({}, { assertions: null }))).toEqual([
        '/meta/assertions must be a plain object',
      ]);
    });

    it('accepts dates, dimensions and tags in the forms normalizeMeta writes', () => {
      expect(() =>
        InputSanitizer.validate(
          input(
            { revenue: { total: 5 } },
            {
              effectiveDate: new Date('2026-01-01T00:00:00Z'),
              dates: { facture: '2025-12-31T23:30:00-01:00' },
              dimensions: { pays: ['US', 'FR', 'US'], zone: 'EU' },
              tags: ['b', 'a', 'b'],
            },
          ),
        ),
      ).not.toThrow();
    });
  });

  describe('the bounds of the input (EngineLimits)', () => {
    const nested = (levels: number): Record<string, unknown> => {
      let value: Record<string, unknown> = { leaf: 1 };
      for (let i = 1; i < levels; i++) value = { a: value };
      return value;
    };
    const failure = (data: Record<string, unknown>, limits: Partial<EngineLimits>): unknown => {
      try {
        InputSanitizer.validate(
          { requestId: 'r', data, meta: { tenantId: 't' } },
          resolveLimits(limits),
        );
      } catch (error) {
        return error;
      }
      return undefined;
    };

    it('holds data to maxInputDepth levels: the limit passes, one more throws', () => {
      expect(failure(nested(3), { maxInputDepth: 3 })).toBeUndefined();
      const error = failure(nested(4), { maxInputDepth: 3 });
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxInputDepth', max: 3, actual: 4 });
    });

    it('holds meta.context to the same depth', () => {
      const error = (() => {
        try {
          InputSanitizer.validate(
            { requestId: 'r', data: {}, meta: { tenantId: 't', context: nested(4) } },
            resolveLimits({ maxInputDepth: 3 }),
          );
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(error).toMatchObject({ limit: 'maxInputDepth', max: 3, actual: 4 });
    });

    it('counts leaves as the input tree does: scalars, lists and empty objects, on every path', () => {
      // Nodes: 4 keys (a, b, c, d); 2 scalars + a list (1) holding 2 scalars + an empty object =
      // 6 leaves; and meta.tenantId, a key and a scalar: 12.
      const data = { a: 1, b: 'x', c: [true, null], d: {} };
      expect(failure(data, { maxInputLeaves: 12 })).toBeUndefined();
      const error = failure(data, { maxInputLeaves: 11 });
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 11, actual: 12 });
    });

    it('counts a shared object once per path, as the JSON text holds it', () => {
      const shared = { x: 1, y: 2 };
      // 2 + 4 keys and 4 leaves, and meta.tenantId (2): 12 nodes.
      expect(failure({ p: shared, q: shared }, { maxInputLeaves: 12 })).toBeUndefined();
      expect(failure({ p: shared, q: shared }, { maxInputLeaves: 11 })).toMatchObject({
        limit: 'maxInputLeaves',
        actual: 12,
      });
    });

    it('counts the leaves of data and of every part of meta together', () => {
      const prepareWith = (meta: Record<string, unknown>, max: number): unknown => {
        try {
          InputSanitizer.prepare(
            { requestId: 'r', data: { a: 1, b: 2 }, meta: { tenantId: 't', ...meta } },
            resolveLimits({ maxInputLeaves: max }),
          );
        } catch (error) {
          return error;
        }
        return undefined;
      };
      // data holds 4 nodes, meta.context 5, tenantId 2: each part alone is under 10, the sum is 11.
      const meta = { context: { c: 1, d: 2 } };
      expect(prepareWith(meta, 11)).toBeUndefined();
      expect(prepareWith(meta, 10)).toMatchObject({
        limit: 'maxInputLeaves',
        max: 10,
        actual: 11,
      });
    });

    describe.each([
      ['tags', { tags: ['a', 'b'] }, 4, { tags: [['a']] }, 2],
      ['dates', { dates: { facture: '2025-01-01' } }, 3, { dates: { a: { b: 1 } } }, 2],
      ['dimensions', { dimensions: { country: 'TG' } }, 3, { dimensions: { a: { b: 'x' } } }, 2],
      [
        'assertions',
        { assertions: { '/a': { by: 'x' } } },
        4,
        { assertions: { a: { b: { c: 1 } } } },
        3,
      ],
      ['context', { context: { k: 1 } }, 3, { context: { a: { b: 1 } } }, 2],
    ] as const)('the part meta.%s is bounded', (_part, withLeaves, leaves, deep, levels) => {
      const prepareWith = (
        meta: Record<string, unknown>,
        limits: Partial<EngineLimits>,
      ): unknown => {
        try {
          InputSanitizer.prepare(
            { requestId: 'r', data: {}, meta: { tenantId: 't', ...meta } },
            resolveLimits(limits),
          );
        } catch (error) {
          return error;
        }
        return undefined;
      };

      it('counts its leaves', () => {
        // The empty data object and tenantId (key and scalar) are 3 nodes: the part's nodes bring
        // the count to 3 + leaves.
        const error = prepareWith(withLeaves, { maxInputLeaves: leaves + 2 });
        expect(error).toMatchObject({
          limit: 'maxInputLeaves',
          max: leaves + 2,
          actual: leaves + 3,
        });
        // At the limit the walk accepts it: any other refusal is spec's, not the bound's.
        expect(prepareWith(withLeaves, { maxInputLeaves: leaves + 3 })).not.toBeInstanceOf(
          EngineLimitError,
        );
      });

      it('counts its depth, from level 1', () => {
        expect(prepareWith(deep, { maxInputDepth: levels - 1 })).toMatchObject({
          limit: 'maxInputDepth',
          max: levels - 1,
          actual: levels,
        });
        expect(prepareWith(deep, { maxInputDepth: levels })).not.toBeInstanceOf(EngineLimitError);
      });
    });

    it('stops a cycle at the depth limit instead of walking it for ever', () => {
      const data: Record<string, unknown> = { a: 1 };
      data['self'] = data;
      expect(failure(data, {})).toMatchObject({ limit: 'maxInputDepth', max: 128, actual: 129 });
    });
  });

  describe('one plain copy per evaluation (prepare)', () => {
    const wrap = (data: unknown, meta: Record<string, unknown> = {}): unknown => ({
      requestId: 'r',
      data,
      meta: { tenantId: 't', ...meta },
    });
    const prepare = (data: unknown, meta: Record<string, unknown> = {}) =>
      InputSanitizer.prepare(wrap(data, meta));
    const reasonsOf = (data: unknown, meta: Record<string, unknown> = {}): readonly string[] => {
      try {
        prepare(data, meta);
      } catch (error) {
        if (error instanceof ValidationError) return error.reasons;
        throw error;
      }
      return expect.unreachable('should have thrown');
    };

    it('hands back copies of data and of the meta, and the canonical meta', () => {
      const data = { revenue: { total: 5 }, list: [{ a: 1 }] };
      const meta = { tags: ['b', 'a'], context: { note: { deep: 1 } } };
      const before = JSON.stringify([data, meta]);
      const prepared = prepare(data, meta);
      expect(prepared.input.data).toEqual(data);
      expect(prepared.input.data).not.toBe(data);
      expect(prepared.input.data['revenue']).not.toBe(data.revenue);
      expect((prepared.input.data['list'] as unknown[])[0]).not.toBe(data.list[0]);
      expect(prepared.input.meta.tags).toEqual(['b', 'a']);
      expect(prepared.input.meta.tags).not.toBe(meta.tags);
      expect(prepared.input.meta.context).not.toBe(meta.context);
      // The canonical meta is the one spec checks: tags sorted, a date for every name.
      expect(prepared.meta.tags).toEqual(['a', 'b']);
      expect(prepared.meta.context).toBe(prepared.input.meta.context);
      expect(JSON.stringify([data, meta])).toBe(before);
    });

    it('reads each property once: the value that is checked is the value that is kept', () => {
      let reads = 0;
      const data: Record<string, unknown> = { a: 1 };
      Object.defineProperty(data, 'g', {
        enumerable: true,
        get: () => (++reads <= 2 ? 1 : 2 ** 53),
      });
      const prepared = prepare(data);
      expect(reads).toBe(1);
      expect(prepared.input.data['g']).toBe(1);
      expect(Object.getOwnPropertyDescriptor(prepared.input.data, 'g')?.get).toBeUndefined();
    });

    it('reads a Proxy once: a trap that changes its answer cannot split the checks from the rules', () => {
      let gets = 0;
      const data = new Proxy({ a: 1, b: 2 } as Record<string, unknown>, {
        get: (target, key) => (++gets <= 2 ? target[key as string] : 2 ** 53),
      });
      const prepared = prepare(data);
      expect(gets).toBe(2);
      expect(prepared.input.data).toEqual({ a: 1, b: 2 });
    });

    it('reads a getter of the meta once as well', () => {
      let reads = 0;
      const context: Record<string, unknown> = {};
      Object.defineProperty(context, 'g', {
        enumerable: true,
        get: () => (++reads <= 2 ? 1 : 2 ** 53),
      });
      expect(prepare({}, { context }).input.meta.context).toEqual({ g: 1 });
      expect(reads).toBe(1);
    });

    it('writes -0 as 0 everywhere, so that the evaluated value is the hashed one (D-5)', () => {
      const data = { z: -0, nested: { z: -0 }, list: [-0, 1] };
      const prepared = prepare(data, { context: { z: -0 } });
      const copy = prepared.input.data as { z: number; nested: { z: number }; list: number[] };
      expect(Object.is(copy.z, 0)).toBe(true);
      expect(Object.is(copy.nested.z, 0)).toBe(true);
      expect(Object.is(copy.list[0], 0)).toBe(true);
      expect(Object.is((prepared.meta.context as { z: number }).z, 0)).toBe(true);
      // The caller's value is left alone.
      expect(Object.is(data.z, -0)).toBe(true);
    });

    it('keeps an own __proto__ key as an own key, and the prototype of the copy untouched', () => {
      const data = JSON.parse('{"a":{"__proto__":{"x":1}},"list":[{"__proto__":2}]}') as Record<
        string,
        unknown
      >;
      const prepared = prepare(data);
      const a = prepared.input.data['a'] as object;
      expect(Object.getOwnPropertyNames(a)).toEqual(['__proto__']);
      expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
      expect(JSON.stringify(prepared.input.data)).toBe(JSON.stringify(data));
    });

    it('leaves what is not JSON as it is, for spec to refuse', () => {
      expect(reasonsOf({ d: new Date(0), m: new Map(), f: () => 1, u: undefined })).toEqual([
        '/data/d is not JSON: a Date: write it as a string',
        '/data/m is not JSON: an object that is neither plain nor an array',
        '/data/f is not JSON: a function',
        '/data/u is not JSON: undefined',
      ]);
    });

    it('keeps the holes of a list, for spec to name them', () => {
      // eslint-disable-next-line no-sparse-arrays
      expect(reasonsOf({ a: [1, , 3] })).toEqual([
        '/data/a has a hole at index 1: arrays must be dense',
      ]);
    });

    it('refuses a lone surrogate in a text as well as in a key', () => {
      expect(reasonsOf({ s: 'a\ud800b' })).toEqual(['/data/s contains a lone UTF-16 surrogate']);
    });

    describe('a property that cannot be read', () => {
      const throwing = (): Record<string, unknown> => {
        const data: Record<string, unknown> = { a: 1 };
        Object.defineProperty(data, 'g', {
          enumerable: true,
          get: () => {
            throw new Error('boom');
          },
        });
        return data;
      };

      it('is named at its pointer, and the rest of the input is still read', () => {
        expect(reasonsOf(throwing())).toEqual(['/data/g could not be read: boom']);
        expect(reasonsOf({ list: [throwing()] })).toEqual([
          '/data/list/0/g could not be read: boom',
        ]);
      });

      it('is named in the meta too, with the pointer of the canonical input', () => {
        expect(reasonsOf({}, { context: throwing() })).toEqual([
          '/meta/context/g could not be read: boom',
        ]);
      });

      it('counts as a leaf: the bound is reached at exactly that leaf', () => {
        // meta.tenantId is two nodes too (key and scalar): the bound of 4 holds g (key and the
        // unreadable leaf) and tenantId, not a and g and it.
        const limits = resolveLimits({ maxInputLeaves: 4 });
        const unreadable = (data: Record<string, unknown>): unknown => {
          try {
            InputSanitizer.prepare({ requestId: 'r', data, meta: { tenantId: 't' } }, limits);
          } catch (error) {
            return error;
          }
          return undefined;
        };
        // g alone is the first leaf: within the bound, and named by the check.
        const only: Record<string, unknown> = {};
        Object.defineProperty(only, 'g', {
          enumerable: true,
          get: () => {
            throw new Error('boom');
          },
        });
        expect(unreadable(only)).toMatchObject({ reasons: ['/data/g could not be read: boom'] });
        // a (key and leaf) and g (key and leaf) are four nodes, tenantId's key the fifth: past the
        // bound of 4.
        expect(unreadable(throwing())).toMatchObject({
          limit: 'maxInputLeaves',
          max: 4,
          actual: 5,
        });
      });

      it('is named when the keys of an object cannot be listed', () => {
        const hostile = new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('no keys');
            },
          },
        );
        expect(reasonsOf({ p: hostile })).toEqual(['/data/p could not be read: no keys']);
      });
    });

    describe('the bounds count the whole input, once', () => {
      const bounded = (
        limits: Partial<EngineLimits>,
        data: Record<string, unknown>,
        meta: Record<string, unknown> = {},
      ): unknown => {
        try {
          InputSanitizer.prepare(wrap(data, meta), resolveLimits(limits));
        } catch (error) {
          return error;
        }
        return undefined;
      };

      it('adds the leaves of data, of the context and of the tags: each under the limit, the sum over', () => {
        const limits = { maxInputLeaves: 15 };
        // data: 3 keys + 3 leaves = 6; context: its key + 3 keys + 3 leaves = 7; tags: its key + a
        // list (1) and 2 items = 4; tenantId 2.
        const data = { a: 1, b: 2, c: 3 };
        const context = { x: 1, y: 2, z: 3 };
        expect(bounded(limits, data, { context })).toBeUndefined();
        expect(bounded(limits, data, { tags: ['p', 'q'] })).toBeUndefined();
        const error = bounded(limits, data, { context, tags: ['p', 'q'] });
        expect(error).toBeInstanceOf(EngineLimitError);
        expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 15, actual: 16 });
      });

      it.each([
        ['tags', { tags: ['a', 'b', 'c'] }],
        ['dates', { dates: { d1: '2026-01-01', d2: '2026-01-02', d3: '2026-01-03' } }],
        ['dimensions', { dimensions: { k1: 'a', k2: 'b', k3: 'c' } }],
        ['assertions', { assertions: { '/a': { x: 1, y: 2, z: 3 } } }],
        ['context', { context: { x: 1, y: 2, z: 3 } }],
      ])('measures meta.%s', (_part, meta) => {
        const error = bounded({ maxInputLeaves: 2 }, {}, meta);
        expect(error).toBeInstanceOf(EngineLimitError);
        expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 2 });
      });

      it.each([
        ['tags', { tags: [[[1]]] }],
        ['dates', { dates: { d: { a: { b: 1 } } } }],
        ['dimensions', { dimensions: { k: { a: { b: 1 } } } }],
        ['assertions', { assertions: { '/a': { x: { y: 1 } } } }],
        ['context', { context: { a: { b: { c: 1 } } } }],
      ])('holds meta.%s to maxInputDepth, its own member being level 1', (_part, meta) => {
        // The member is level 1; nesting it three containers deep is level 3 or 4.
        const error = bounded({ maxInputDepth: 2 }, {}, meta);
        expect(error).toBeInstanceOf(EngineLimitError);
        expect(error).toMatchObject({ limit: 'maxInputDepth', max: 2 });
      });

      it('does not count an empty container as a level of depth, as spec does', () => {
        expect(bounded({ maxInputDepth: 1 }, { a: {} })).toBeUndefined();
        expect(bounded({ maxInputDepth: 1 }, { a: { b: 1 } })).toMatchObject({
          limit: 'maxInputDepth',
          actual: 2,
        });
      });
    });
  });
});
