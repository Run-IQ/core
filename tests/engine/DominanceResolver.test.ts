import { describe, it, expect } from 'vitest';
import { DominanceResolver } from '../../src/engine/DominanceResolver.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { makeRule } from '../helpers.js';

describe('DominanceResolver', () => {
  const resolver = new DominanceResolver();

  it('sorts rules by priority descending', () => {
    const rules = [
      makeRule({ id: 'low', model: 'M', priority: 100 }),
      makeRule({ id: 'high', model: 'M', priority: 300 }),
      makeRule({ id: 'mid', model: 'M', priority: 200 }),
    ];
    const result = resolver.resolve(rules, 'throw');
    expect(result[0]!.id).toBe('high');
    expect(result[1]!.id).toBe('mid');
    expect(result[2]!.id).toBe('low');
  });

  it('throws RuleConflictError in strict mode when priorities conflict', () => {
    const rules = [
      makeRule({ id: 'r1', model: 'M', priority: 100, dominanceGroup: 'G1' }),
      makeRule({ id: 'r2', model: 'M', priority: 100, dominanceGroup: 'G1' }),
    ];
    expect(() => resolver.resolve(rules, 'throw')).toThrow(RuleConflictError);
  });

  it('keeps first rule in lenient mode when priorities conflict', () => {
    const rules = [
      makeRule({ id: 'r1', model: 'M', priority: 100, dominanceGroup: 'G1' }),
      makeRule({ id: 'r2', model: 'M', priority: 100, dominanceGroup: 'G1' }),
    ];
    const result = resolver.resolve(rules, 'first');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('r1');
  });

  it('returns empty array for no rules', () => {
    const result = resolver.resolve([], 'throw');
    expect(result).toHaveLength(0);
  });

  it('returns single rule unchanged', () => {
    const rules = [makeRule({ id: 'r1', model: 'M', priority: 100 })];
    const result = resolver.resolve(rules, 'throw');
    expect(result).toHaveLength(1);
  });
});
