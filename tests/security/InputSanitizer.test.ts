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
      // 2 scalars + a list (1) holding 2 scalars + an empty object = 6 leaves.
      const data = { a: 1, b: 'x', c: [true, null], d: {} };
      expect(failure(data, { maxInputLeaves: 6 })).toBeUndefined();
      const error = failure(data, { maxInputLeaves: 5 });
      expect(error).toBeInstanceOf(EngineLimitError);
      expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 5, actual: 6 });
    });

    it('counts a shared object once per path, as the JSON text holds it', () => {
      const shared = { x: 1, y: 2 };
      expect(failure({ p: shared, q: shared }, { maxInputLeaves: 4 })).toBeUndefined();
      expect(failure({ p: shared, q: shared }, { maxInputLeaves: 3 })).toMatchObject({
        limit: 'maxInputLeaves',
        actual: 4,
      });
    });

    it('stops a cycle at the depth limit instead of walking it for ever', () => {
      const data: Record<string, unknown> = { a: 1 };
      data['self'] = data;
      expect(failure(data, {})).toMatchObject({ limit: 'maxInputDepth', max: 128, actual: 129 });
    });
  });
});
