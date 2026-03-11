import { describe, it, expect } from 'vitest';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { ValidationError } from '../../src/errors/ValidationError.js';

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
});
