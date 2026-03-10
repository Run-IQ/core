import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../../src/registry/PluginRegistry.js';
import { StubPlugin, StubModel } from '../helpers.js';

describe('PluginRegistry', () => {
  it('registers and retrieves a plugin', () => {
    const registry = new PluginRegistry();
    const plugin = new StubPlugin('fiscal');
    registry.register(plugin);
    expect(registry.get('fiscal')).toBe(plugin);
  });

  it('returns undefined for an unregistered plugin', () => {
    const registry = new PluginRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('checks existence with has()', () => {
    const registry = new PluginRegistry();
    registry.register(new StubPlugin('fiscal'));
    expect(registry.has('fiscal')).toBe(true);
    expect(registry.has('payroll')).toBe(false);
  });

  it('returns all registered plugins via getAll()', () => {
    const registry = new PluginRegistry();
    const p1 = new StubPlugin('fiscal');
    const p2 = new StubPlugin('payroll');
    registry.register(p1);
    registry.register(p2);

    const all = registry.getAll();
    expect(all.size).toBe(2);
    expect(all.get('fiscal')).toBe(p1);
    expect(all.get('payroll')).toBe(p2);
  });

  it('throws on duplicate name registration', () => {
    const registry = new PluginRegistry();
    registry.register(new StubPlugin('fiscal'));
    expect(() => registry.register(new StubPlugin('fiscal'))).toThrow('already registered');
  });

  it('allows plugins with different names', () => {
    const registry = new PluginRegistry();
    registry.register(new StubPlugin('fiscal', [new StubModel('M1')]));
    registry.register(new StubPlugin('payroll', [new StubModel('M2')]));
    expect(registry.has('fiscal')).toBe(true);
    expect(registry.has('payroll')).toBe(true);
  });
});
