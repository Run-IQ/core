import { describe, it, expect } from 'vitest';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { ModelNotFoundError } from '../../src/errors/ModelNotFoundError.js';
import { InvalidModelError } from '../../src/errors/InvalidModelError.js';
import { StubModel, ValueModel } from '../helpers.js';

describe('ModelRegistry', () => {
  it('registers and retrieves a model', () => {
    const registry = new ModelRegistry();
    const model = new StubModel('FLAT_RATE');
    registry.register(model);
    expect(registry.get('FLAT_RATE')).toBe(model);
  });

  it('throws on duplicate registration', () => {
    const registry = new ModelRegistry();
    registry.register(new StubModel('FLAT_RATE'));
    expect(() => registry.register(new StubModel('FLAT_RATE'))).toThrow('already registered');
  });

  it('throws ModelNotFoundError for unregistered model', () => {
    const registry = new ModelRegistry();
    expect(() => registry.get('UNKNOWN')).toThrow(ModelNotFoundError);
  });

  it('checks existence', () => {
    const registry = new ModelRegistry();
    registry.register(new StubModel('M'));
    expect(registry.has('M')).toBe(true);
    expect(registry.has('NOPE')).toBe(false);
  });

  describe('output declarations', () => {
    const refusal = (output: unknown): InvalidModelError => {
      // The declarations below are invalid on purpose: only JSON.parse builds them untyped.
      const model = new ValueModel('BAD', JSON.parse(JSON.stringify(output)), {});
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
      expect(sum.modelName).toBe('BAD');
      expect(sum.issues).toEqual([
        'output.combine "sum" cannot combine a string output: it applies to number',
      ]);
      expect(sum.message).toBe(
        'Model "BAD" declares an invalid output: output.combine "sum" cannot combine a string output: it applies to number',
      );
      expect(refusal({ type: 'number', combine: 'avg' }).issues).toEqual([
        'output.combine must be one of sum, max, min, highestPriority, union, all, any',
      ]);
      expect(refusal({ type: 'enum', combine: 'highestPriority' }).issues).toEqual([
        'output.values is required for an enum output: list its allowed strings',
      ]);
    });

    it('accepts a valid declaration and a model without one', () => {
      const registry = new ModelRegistry();
      registry.register(new ValueModel('LIST', { type: 'list', combine: 'union' }, {}));
      registry.register(new StubModel('PLAIN'));
      expect([registry.has('LIST'), registry.has('PLAIN')]).toEqual([true, true]);
    });
  });
});
