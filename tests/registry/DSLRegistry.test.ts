import { describe, it, expect } from 'vitest';
import { DSLRegistry } from '../../src/registry/DSLRegistry.js';
import { StubDSL } from '../helpers.js';

describe('DSLRegistry', () => {
  it('registers and retrieves a DSL evaluator', () => {
    const registry = new DSLRegistry();
    const dsl = new StubDSL('jsonlogic');
    registry.register(dsl);
    expect(registry.get('jsonlogic')).toBe(dsl);
  });

  it('throws on duplicate registration', () => {
    const registry = new DSLRegistry();
    registry.register(new StubDSL('jsonlogic'));
    expect(() => registry.register(new StubDSL('jsonlogic'))).toThrow('already registered');
  });

  it('returns undefined for unregistered DSL', () => {
    const registry = new DSLRegistry();
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('checks existence', () => {
    const registry = new DSLRegistry();
    registry.register(new StubDSL('cel'));
    expect(registry.has('cel')).toBe(true);
    expect(registry.has('nope')).toBe(false);
  });
});
