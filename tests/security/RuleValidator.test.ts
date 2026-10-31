import { describe, it, expect } from 'vitest';
import { EXCEPTION_MODEL } from '@run-iq/spec';
import { RuleValidator } from '../../src/security/RuleValidator.js';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { makeRule, StubModel } from '../helpers.js';
import type { CalculationModel, ValidationResult } from '../../src/types/model.js';
import type { Rule } from '../../src/types/rule.js';
import { ValidationError } from '../../src/errors/ValidationError.js';

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
    expect(result.invalid[0]!.detail).toBe('Invalid params for rule r1@1 (model BAD): bad param');
  });

  it('says so when a model refuses params without giving errors', () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'MUTE',
      version: '1.0.0',
      validateParams: (): ValidationResult => ({ valid: false }),
      calculate: () => 0,
    });
    const result = new RuleValidator(registry).validate([makeRule({ id: 'r1', model: 'MUTE' })]);
    expect(result.invalid.map((s) => [s.reason, s.detail])).toEqual([
      ['INVALID_PARAMS', 'Invalid params for rule r1@1 (model MUTE): the model gave no error'],
    ]);
  });

  it('names the rule in the detail of a checksum mismatch', () => {
    const rule = { ...makeRule({ id: 'r1', model: 'M' }), checksum: 'f'.repeat(64) };
    const result = new RuleValidator(new ModelRegistry()).validate([rule]);
    expect(result.invalid.map((s) => [s.reason, s.detail])).toEqual([
      ['CHECKSUM_MISMATCH', 'Checksum mismatch for rule r1@1'],
    ]);
  });

  it('excludes an exception carrier without exceptions as INVALID_RULE with the spec message', () => {
    const carrier = { ...makeRule({ id: 'X', model: 'M' }), model: EXCEPTION_MODEL };
    const result = new RuleValidator(new ModelRegistry()).validate([carrier]);
    expect(result.valid).toEqual([]);
    expect(result.invalid.map((s) => [s.reason, s.detail])).toEqual([
      [
        'INVALID_RULE',
        'Invalid rule X@1: exceptions must list at least one exception: ' +
          'a rule of model "@run-iq/exception" only carries exceptions',
      ],
    ]);
  });

  it('never validates the params of an exception carrier', () => {
    const registry = new ModelRegistry();
    // A plugin registering the reserved name does not make core validate carrier params.
    registry.register({
      name: EXCEPTION_MODEL,
      version: '1.0.0',
      validateParams: (): ValidationResult => ({ valid: false, errors: ['refused'] }),
      calculate: () => 0,
    });
    const carrier = makeRule({
      id: 'X',
      model: EXCEPTION_MODEL,
      exceptions: [{ kind: 'inhibit', targets: { ids: ['a'] } }],
    });
    const result = new RuleValidator(registry).validate([carrier]);
    expect(result.valid).toEqual([carrier]);
    expect(result.invalid).toEqual([]);
  });

  it('skips a malformed rule as INVALID_RULE with the spec error as detail', () => {
    const validator = new RuleValidator(new ModelRegistry());
    const rule = makeRule({ id: 'r1', model: 'M' });
    const malformed = { ...rule, effectiveFrom: new Date('not a date') };
    const result = validator.validate([malformed]);
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.reason).toBe('INVALID_RULE');
    expect(result.invalid[0]!.detail).toMatch(/^Invalid rule r1@1: .*effectiveFrom/);
  });

  it('throws a ValidationError for a malformed rule when onChecksumMismatch is throw', () => {
    const validator = new RuleValidator(new ModelRegistry(), 'throw');
    const rule = makeRule({ id: 'r1', model: 'M' });
    expect(() => validator.validate([{ ...rule, version: 1.5 }])).toThrow(ValidationError);
    expect(() => validator.validate([{ ...rule, version: 1.5 }])).toThrow(/Invalid rule r1@1\.5/);
  });
});
