import { describe, it, expect } from 'vitest';
import { RuleValidator } from '../../src/security/RuleValidator.js';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { makeRule, StubModel } from '../helpers.js';
import type { CalculationModel, ValidationResult } from '../../src/types/model.js';
import type { Rule } from '../../src/types/rule.js';

describe('RuleValidator', () => {
  it('passes rules with valid checksum', () => {
    const registry = new ModelRegistry();
    registry.register(new StubModel('M'));
    const validator = new RuleValidator(registry);

    const rule = makeRule({ id: 'r1', model: 'M', params: { rate: 0.18 } });
    const result = validator.validate([rule]);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(0);
  });

  it('rejects rules with tampered checksum', () => {
    const registry = new ModelRegistry();
    registry.register(new StubModel('M'));
    const validator = new RuleValidator(registry);

    const rule = makeRule({ id: 'r1', model: 'M', params: { rate: 0.18 } });
    // Tamper the checksum
    const tampered = { ...rule, checksum: 'bad_checksum' };
    const result = validator.validate([tampered]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.reason).toBe('CHECKSUM_MISMATCH');
  });

  it('rejects rules with invalid params', () => {
    const badModel: CalculationModel = {
      name: 'BAD',
      version: '1.0.0',
      validateParams: (): ValidationResult => ({ valid: false, errors: ['bad param'] }),
      calculate: (_i: Record<string, unknown>, _r: Readonly<Rule>, _p: unknown) => 0,
    };
    const registry = new ModelRegistry();
    registry.register(badModel);
    const validator = new RuleValidator(registry);

    const rule = makeRule({ id: 'r1', model: 'BAD', params: { x: 1 } });
    const result = validator.validate([rule]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.reason).toBe('INVALID_PARAMS');
  });
});
