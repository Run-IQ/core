import { describe, it, expect } from 'vitest';
import { computeRuleChecksum as specChecksum } from '@run-iq/spec';
import { PPEEngine, ValidationError, computeRuleChecksum, hydrateRule } from '../../src/index.js';
import type { Rule } from '../../src/index.js';
import { makeInput, StubModel, StubPlugin } from '../helpers.js';

function sealedRule(): Rule {
  const definition = {
    id: 'vat',
    version: 1,
    model: 'M',
    params: { rate: 0.18 },
    priority: 100,
    effectiveFrom: new Date('2025-01-01'),
    effectiveUntil: null,
    dimensions: {},
    tags: [],
  };
  return { ...definition, checksum: computeRuleChecksum(definition) };
}

function engine(): PPEEngine {
  return new PPEEngine({
    plugins: [new StubPlugin('test', [new StubModel('M', 42)])],
    dsls: [],
    strict: false,
  });
}

const input = makeInput({ meta: { tenantId: 't', effectiveDate: new Date('2025-06-01') } });

describe('checksum compatibility with @run-iq/spec', () => {
  it('seals with the spec checksum, dates normalized', () => {
    const rule = sealedRule();
    expect(rule.checksum).toBe(specChecksum(rule));
    expect(computeRuleChecksum({ ...rule, effectiveFrom: '2025-01-01' })).toBe(rule.checksum);
  });

  it('a rule sealed by core passes engine.evaluate', async () => {
    const result = await engine().evaluate([sealedRule()], input);
    expect(result.skippedRules).toEqual([]);
    expect(result.appliedRules.map((r) => r.id)).toEqual(['vat']);
  });

  it('the same rule rebuilt by hydrateRule from JSON passes too', async () => {
    const raw = JSON.parse(JSON.stringify(sealedRule())) as Record<string, unknown>;
    const rule = hydrateRule(raw);
    expect(rule.effectiveFrom).toBeInstanceOf(Date);
    expect(rule.checksum).toBe(sealedRule().checksum);
    const result = await engine().evaluate([rule], input);
    expect(result.appliedRules.map((r) => r.id)).toEqual(['vat']);
  });

  it('a rule whose params.rate changed after sealing is skipped with CHECKSUM_MISMATCH', async () => {
    const tampered: Rule = { ...sealedRule(), params: { rate: 0.2 } };
    const result = await engine().evaluate([tampered], input);
    expect(result.appliedRules).toEqual([]);
    expect(result.skippedRules.map((s) => s.reason)).toEqual(['CHECKSUM_MISMATCH']);
  });

  it('hydrateRule keeps the stored checksum, so a tampered row is still detected', async () => {
    const raw = JSON.parse(JSON.stringify(sealedRule())) as Record<string, unknown>;
    raw.params = { rate: 0.2 };
    const result = await engine().evaluate([hydrateRule(raw)], input);
    expect(result.skippedRules.map((s) => s.reason)).toEqual(['CHECKSUM_MISMATCH']);
  });

  it('a malformed rule does not crash the evaluation: it is skipped as INVALID_RULE', async () => {
    const malformed: Rule = { ...sealedRule(), effectiveUntil: new Date('2024-01-01') };
    const result = await engine().evaluate([malformed, sealedRule()], input);
    expect(result.appliedRules.map((r) => r.id)).toEqual(['vat']);
    expect(result.skippedRules).toHaveLength(1);
    expect(result.skippedRules[0]!.reason).toBe('INVALID_RULE');
    expect(result.skippedRules[0]!.detail).toMatch(/window/);
  });

  it('hydrateRule reports an invalid definition as a ValidationError', () => {
    const raw = JSON.parse(JSON.stringify(sealedRule())) as Record<string, unknown>;
    raw.effectiveFrom = '2025-01-01T00:00:00';
    expect(() => hydrateRule(raw)).toThrow(ValidationError);
    expect(() => hydrateRule(raw)).toThrow(/vat@1/);
  });

  it('hydrateRule lists every problem of an invalid definition', () => {
    const raw = JSON.parse(JSON.stringify(sealedRule())) as Record<string, unknown>;
    raw.effectiveFrom = 'invalid-date';
    raw.tags = 'not-an-array';
    try {
      hydrateRule(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const reasons = (error as ValidationError).reasons;
      expect(reasons).toHaveLength(2);
      expect(reasons[0]).toMatch(/^effectiveFrom/);
      expect(reasons[1]).toMatch(/^tags must be an array/);
    }
  });
});
