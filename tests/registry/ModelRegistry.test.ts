import { describe, it, expect } from 'vitest';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { ModelNotFoundError } from '../../src/errors/ModelNotFoundError.js';
import { StubModel } from '../helpers.js';

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
});
