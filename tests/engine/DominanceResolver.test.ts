import { describe, it, expect } from 'vitest';
import { DominanceResolver } from '../../src/engine/DominanceResolver.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { makeRule } from '../helpers.js';

describe('DominanceResolver', () => {
  const resolver = new DominanceResolver();

  it('sorts rules by priority descending, then id ascending', () => {
    const rules = [
      makeRule({ id: 'z', model: 'M', priority: 100 }),
      makeRule({ id: 'high', model: 'M', priority: 300 }),
      makeRule({ id: 'b', model: 'M', priority: 100 }),
      makeRule({ id: 'mid', model: 'M', priority: 200 }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'throw');
    expect(kept.map((r) => r.id)).toEqual(['high', 'mid', 'b', 'z']);
    expect(skipped).toEqual([]);
  });

  it('keeps only the highest priority of a dominance group', () => {
    const rules = [
      makeRule({ id: 'tva-local', model: 'M', priority: 1000, dominanceGroup: 'tva' }),
      makeRule({
        id: 'tva-national',
        model: 'M',
        priority: 3000,
        version: 2,
        dominanceGroup: 'tva',
      }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'throw');
    expect(kept.map((r) => r.id)).toEqual(['tva-national']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.rule.id).toBe('tva-local');
    expect(skipped[0]!.reason).toBe('DOMINATED');
    expect(skipped[0]!.detail).toBe('dominated by tva-national@2 (priority 3000) in group tva');
  });

  it('does not mix different groups', () => {
    const rules = [
      makeRule({ id: 'a', model: 'M', priority: 3000, dominanceGroup: 'g1' }),
      makeRule({ id: 'b', model: 'M', priority: 1000, dominanceGroup: 'g2' }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'throw');
    expect(kept.map((r) => r.id)).toEqual(['a', 'b']);
    expect(skipped).toEqual([]);
  });

  it('throws RuleConflictError with both ids on a tie at the top of a group', () => {
    const rules = [
      makeRule({ id: 'r1', model: 'M', priority: 100, dominanceGroup: 'G1' }),
      makeRule({ id: 'r2', model: 'M', priority: 100, dominanceGroup: 'G1' }),
    ];
    try {
      resolver.resolve(rules, 'throw');
      expect.unreachable('should have thrown');
    } catch (e) {
      if (!(e instanceof RuleConflictError)) throw e;
      expect(e.ruleIds).toEqual(['r1', 'r2']);
    }
  });

  it("keeps the smallest id on a top tie in 'first' mode and marks the other RULE_CONFLICT", () => {
    const rules = [
      makeRule({ id: 'r2', model: 'M', priority: 100, dominanceGroup: 'G1' }),
      makeRule({ id: 'r1', model: 'M', priority: 100, dominanceGroup: 'G1' }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'first');
    expect(kept.map((r) => r.id)).toEqual(['r1']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.rule.id).toBe('r2');
    expect(skipped[0]!.reason).toBe('RULE_CONFLICT');
    expect(skipped[0]!.detail).toBe('tied with r1@1 at priority 100; the smallest id wins');
  });

  it('does not conflict on a tie below the head: both are DOMINATED', () => {
    const rules = [
      makeRule({ id: 'top', model: 'M', priority: 5000, dominanceGroup: 'g' }),
      makeRule({ id: 'x', model: 'M', priority: 1000, dominanceGroup: 'g' }),
      makeRule({ id: 'y', model: 'M', priority: 1000, dominanceGroup: 'g' }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'throw');
    expect(kept.map((r) => r.id)).toEqual(['top']);
    expect(skipped.map((s) => [s.rule.id, s.reason])).toEqual([
      ['x', 'DOMINATED'],
      ['y', 'DOMINATED'],
    ]);
  });

  it('never dominates nor conflicts rules without a group, even at equal priority', () => {
    const rules = [
      makeRule({ id: 'b', model: 'M', priority: 100 }),
      makeRule({ id: 'a', model: 'M', priority: 100 }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'throw');
    expect(kept.map((r) => r.id)).toEqual(['a', 'b']);
    expect(skipped).toEqual([]);
  });

  it('returns nothing for no rules', () => {
    expect(resolver.resolve([], 'throw')).toEqual({ kept: [], skipped: [] });
  });
});
