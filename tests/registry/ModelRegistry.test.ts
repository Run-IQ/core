import { describe, it, expect } from 'vitest';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { ModelNotFoundError } from '../../src/errors/ModelNotFoundError.js';
import { InvalidModelError } from '../../src/errors/InvalidModelError.js';
import { StubModel, ValueModel } from '../helpers.js';

describe('ModelRegistry', () => {
  it('registers and retrieves a model', () => {
    const registry = new ModelRegistry();
    const model = new StubModel('flat_rate');
    registry.register(model);
    expect(registry.get('flat_rate')).toBe(model);
  });

  it('throws on duplicate registration', () => {
    const registry = new ModelRegistry();
    registry.register(new StubModel('flat_rate'));
    expect(() => registry.register(new StubModel('flat_rate'))).toThrow('already registered');
  });

  it('throws ModelNotFoundError for unregistered model', () => {
    const registry = new ModelRegistry();
    expect(() => registry.get('UNKNOWN')).toThrow(ModelNotFoundError);
  });

  it('checks existence', () => {
    const registry = new ModelRegistry();
    registry.register(new StubModel('m'));
    expect(registry.has('m')).toBe(true);
    expect(registry.has('NOPE')).toBe(false);
  });

  describe('output declarations', () => {
    const refusal = (output: unknown): InvalidModelError => {
      // The declarations below are invalid on purpose: only JSON.parse builds them untyped.
      const model = new ValueModel('bad', JSON.parse(JSON.stringify(output)), {});
      try {
        new ModelRegistry().register(model);
      } catch (e) {
        if (e instanceof InvalidModelError) return e;
        throw e;
      }
      return expect.unreachable('should have thrown');
    };

    it('refuses a declaration spec does not accept, listing the issues', () => {
      const sum = refusal({ type: 'string', combine: 'sum' });
      expect(sum.code).toBe('INVALID_MODEL');
      expect(sum.modelName).toBe('bad');
      expect(sum.issues).toEqual([
        'output.combine "sum" cannot combine a string output: it applies to number, decimal',
      ]);
      expect(sum.message).toBe(
        'Model "bad" declares an invalid output: output.combine "sum" cannot combine a string output: it applies to number, decimal',
      );
      expect(refusal({ type: 'number', combine: 'avg' }).issues).toEqual([
        'output.combine must be one of sum, max, min, highestPriority, union, all, any, count',
      ]);
      expect(refusal({ type: 'enum', combine: 'highestPriority' }).issues).toEqual([
        'output.values is required for an enum output: list its allowed strings',
      ]);
    });

    it('refuses an invalid rounding, or a rounding on an output that is not a number', () => {
      expect(
        refusal({ type: 'string', combine: 'highestPriority', rounding: { scale: 2, mode: 'up' } })
          .issues,
      ).toEqual(['output.rounding applies only to a number or decimal output']);
      expect(
        refusal({ type: 'decimal', combine: 'sum', rounding: { scale: 21, mode: 'round' } }).issues,
      ).toEqual([
        'output.rounding.scale must be an integer from 0 to 20',
        'output.rounding.mode must be one of halfUp, halfDown, halfEven, up, down, ceiling, floor',
      ]);
    });

    it('accepts a valid declaration and a model without one', () => {
      const registry = new ModelRegistry();
      registry.register(new ValueModel('list', { type: 'list', combine: 'union' }, {}));
      registry.register(
        new ValueModel(
          'tax',
          {
            type: 'decimal',
            combine: 'sum',
            rounding: { scale: 2, mode: 'halfEven', at: 'contribution' },
          },
          {},
        ),
      );
      registry.register(new StubModel('plain'));
      expect([registry.has('list'), registry.has('tax'), registry.has('plain')]).toEqual([
        true,
        true,
        true,
      ]);
    });
  });
});
