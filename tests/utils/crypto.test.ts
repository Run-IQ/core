import { describe, it, expect } from 'vitest';
import { computeRuleChecksum } from '../../src/utils/crypto.js';

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
    const hashB = computeRuleChecksum({ ...fullRule, params: { rate: 0.20 } });

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
    expect(computeRuleChecksum({ ...fullRule, effectiveFrom: new Date('2025-01-01') })).not.toBe(base);
    expect(computeRuleChecksum({ ...fullRule, effectiveUntil: new Date('2026-01-01') })).not.toBe(base);
    expect(computeRuleChecksum({ ...fullRule, tags: ['other'] })).not.toBe(base);
    expect(computeRuleChecksum({ ...fullRule, model: 'OTHER' })).not.toBe(base);
  });

  it('handles rules without optional fields', () => {
    const minimal = { id: 'r1', model: 'M', params: {}, version: 1 };
    const hash = computeRuleChecksum(minimal);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
