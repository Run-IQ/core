import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalize, SpecError } from '@run-iq/spec';
import { computeRuleChecksum, hashParams } from '../../src/utils/crypto.js';

describe('computeRuleChecksum', () => {
  const fullRule = {
    id: 'rule-1',
    version: 1,
    model: 'FLAT_RATE',
    params: { rate: 0.18 },
    priority: 100,
    effectiveFrom: new Date('2024-01-01'),
    effectiveUntil: null,
    tags: ['tax'],
  };

  it('returns the same hash for the same input across multiple calls', () => {
    const hash1 = computeRuleChecksum(fullRule);
    const hash2 = computeRuleChecksum(fullRule);
    const hash3 = computeRuleChecksum(fullRule);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('returns different hashes for different inputs', () => {
    const hashA = computeRuleChecksum(fullRule);
    const hashB = computeRuleChecksum({ ...fullRule, params: { rate: 0.2 } });

    expect(hashA).not.toBe(hashB);
  });

  it('produces the same hash regardless of key ordering in params', () => {
    const hashA = computeRuleChecksum({ ...fullRule, params: { b: 2, a: 1 } });
    const hashB = computeRuleChecksum({ ...fullRule, params: { a: 1, b: 2 } });

    expect(hashA).toBe(hashB);
  });

  it('returns a hex string of 64 characters (SHA-256)', () => {
    const hash = computeRuleChecksum(fullRule);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes condition in the checksum', () => {
    const hashBase = computeRuleChecksum(fullRule);
    const hashCond = computeRuleChecksum({
      ...fullRule,
      condition: { dsl: 'jsonlogic', value: true },
    });

    expect(hashBase).not.toBe(hashCond);
  });

  it('excludes the checksum field from the hash', () => {
    const hash = computeRuleChecksum(fullRule);
    const hashWithChecksum = computeRuleChecksum({ ...fullRule, checksum: 'should-be-ignored' });

    expect(hash).toBe(hashWithChecksum);
  });

  it('includes all rule fields in the hash', () => {
    const base = computeRuleChecksum(fullRule);

    // Changing any field should produce a different hash
    expect(computeRuleChecksum({ ...fullRule, id: 'rule-2' })).not.toBe(base);
    expect(computeRuleChecksum({ ...fullRule, version: 2 })).not.toBe(base);
    expect(computeRuleChecksum({ ...fullRule, priority: 200 })).not.toBe(base);
    expect(computeRuleChecksum({ ...fullRule, effectiveFrom: new Date('2025-01-01') })).not.toBe(
      base,
    );
    expect(computeRuleChecksum({ ...fullRule, effectiveUntil: new Date('2026-01-01') })).not.toBe(
      base,
    );
    expect(computeRuleChecksum({ ...fullRule, tags: ['other'] })).not.toBe(base);
    expect(computeRuleChecksum({ ...fullRule, model: 'OTHER' })).not.toBe(base);
  });

  it('handles rules without optional fields', () => {
    // Required fields only (spec: priority and effectiveFrom are required)
    const minimal = {
      id: 'r1',
      model: 'M',
      params: {},
      version: 1,
      priority: 100,
      effectiveFrom: new Date('2024-01-01'),
    };
    const hash = computeRuleChecksum(minimal);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashParams', () => {
  it('is the sha256 of spec canonicalize', () => {
    const params = { 'a"b': 1, z: [1, { y: 2, x: 1 }] };
    expect(hashParams(params)).toBe(
      createHash('sha256').update(canonicalize(params)).digest('hex'),
    );
  });

  it.each([
    ['NaN', { rate: NaN }],
    ['Infinity', { rate: Infinity }],
    ['a Map', { rate: new Map() }],
  ])('throws SpecError on %s', (_name, params) => {
    expect(() => hashParams(params)).toThrow(SpecError);
  });
});
