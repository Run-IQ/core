import { describe, it, expect } from 'vitest';
import { DominanceResolver } from '../../src/engine/DominanceResolver.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { makeRule } from '../helpers.js';

describe('DominanceResolver', () => {
  const resolver = new DominanceResolver();

  it('sorts rules by priority descending, then id ascending', () => {
    const rules = [
      makeRule({ id: 'z', model: 'm', priority: 100 }),
      makeRule({ id: 'high', model: 'm', priority: 300 }),
      makeRule({ id: 'b', model: 'm', priority: 100 }),
      makeRule({ id: 'mid', model: 'm', priority: 200 }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'throw');
    expect(kept.map((r) => r.id)).toEqual(['high', 'mid', 'b', 'z']);
    expect(skipped).toEqual([]);
  });

  it('keeps only the highest priority of a dominance group', () => {
    const rules = [
      makeRule({ id: 'tva-local', model: 'm', priority: 1000, dominanceGroup: 'tva' }),
      makeRule({
        id: 'tva-national',
        model: 'm',
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
      makeRule({ id: 'a', model: 'm', priority: 3000, dominanceGroup: 'g1' }),
      makeRule({ id: 'b', model: 'm', priority: 1000, dominanceGroup: 'g2' }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'throw');
    expect(kept.map((r) => r.id)).toEqual(['a', 'b']);
    expect(skipped).toEqual([]);
  });

  it('throws RuleConflictError with both ids on a tie at the top of a group', () => {
    const rules = [
      makeRule({ id: 'r1', model: 'm', priority: 100, dominanceGroup: 'G1' }),
      makeRule({ id: 'r2', model: 'm', priority: 100, dominanceGroup: 'G1' }),
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
      makeRule({ id: 'r2', model: 'm', priority: 100, dominanceGroup: 'G1' }),
      makeRule({ id: 'r1', model: 'm', priority: 100, dominanceGroup: 'G1' }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'first');
    expect(kept.map((r) => r.id)).toEqual(['r1']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.rule.id).toBe('r2');
    expect(skipped[0]!.reason).toBe('RULE_CONFLICT');
    expect(skipped[0]!.detail).toBe('tied with r1@1 at priority 100; the lowest id@version wins');
  });

  it('does not conflict on a tie below the head: both are DOMINATED', () => {
    const rules = [
      makeRule({ id: 'top', model: 'm', priority: 5000, dominanceGroup: 'g' }),
      makeRule({ id: 'x', model: 'm', priority: 1000, dominanceGroup: 'g' }),
      makeRule({ id: 'y', model: 'm', priority: 1000, dominanceGroup: 'g' }),
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
      makeRule({ id: 'b', model: 'm', priority: 100 }),
      makeRule({ id: 'a', model: 'm', priority: 100 }),
    ];
    const { kept, skipped } = resolver.resolve(rules, 'throw');
    expect(kept.map((r) => r.id)).toEqual(['a', 'b']);
    expect(skipped).toEqual([]);
  });

  it('returns nothing for no rules', () => {
    expect(resolver.resolve([], 'throw')).toEqual({ kept: [], skipped: [] });
  });

  describe('determinism', () => {
    const fixture = [
      makeRule({ id: 'g1-a', model: 'm', priority: 3000, dominanceGroup: 'g1' }),
      makeRule({ id: 'g1-b', model: 'm', priority: 1000, dominanceGroup: 'g1' }),
      makeRule({ id: 'g1-c', model: 'm', priority: 1000, dominanceGroup: 'g1' }),
      makeRule({ id: 'g2-a', model: 'm', priority: 200, dominanceGroup: 'g2' }),
      makeRule({ id: 'g2-b', model: 'm', priority: 200, dominanceGroup: 'g2', version: 2 }),
      makeRule({ id: 'g2-b', model: 'm', priority: 200, dominanceGroup: 'g2', version: 1 }),
      makeRule({ id: 'g2-z', model: 'm', priority: 50, dominanceGroup: 'g2' }),
      makeRule({ id: 'free-2', model: 'm', priority: 200 }),
      makeRule({ id: 'free-1', model: 'm', priority: 200 }),
    ];

    const permutations = <T>(items: readonly T[]): T[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );

    it("returns identical {kept, skipped} for every input order in 'first' mode", () => {
      const expected = resolver.resolve(fixture, 'first');
      expect(expected.skipped.map((s) => `${s.rule.id}@${s.rule.version}:${s.reason}`)).toEqual([
        'g1-b@1:DOMINATED',
        'g1-c@1:DOMINATED',
        'g2-b@1:RULE_CONFLICT',
        'g2-b@2:RULE_CONFLICT',
        'g2-z@1:DOMINATED',
      ]);
      const small = fixture.slice(0, 7);
      const baseline = resolver.resolve(small, 'first');
      for (const order of permutations(small)) {
        expect(resolver.resolve(order, 'first')).toEqual(baseline);
      }
      for (let shift = 0; shift < fixture.length; shift++) {
        const rotated = [...fixture.slice(shift), ...fixture.slice(0, shift)].reverse();
        expect(resolver.resolve(rotated, 'first')).toEqual(expected);
      }
    });

    it("raises the same conflict for every input order when two groups conflict in 'throw' mode", () => {
      const rules = [
        makeRule({ id: 'q2', model: 'm', priority: 10, dominanceGroup: 'zeta' }),
        makeRule({ id: 'q1', model: 'm', priority: 10, dominanceGroup: 'zeta' }),
        makeRule({ id: 'p2', model: 'm', priority: 20, dominanceGroup: 'alpha' }),
        makeRule({ id: 'p1', model: 'm', priority: 20, dominanceGroup: 'alpha' }),
      ];
      for (const order of permutations(rules)) {
        try {
          resolver.resolve(order, 'throw');
          expect.unreachable('should have thrown');
        } catch (e) {
          if (!(e instanceof RuleConflictError)) throw e;
          expect(e.ruleIds).toEqual(['p1', 'p2']);
        }
      }
    });
  });
});
