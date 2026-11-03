import { describe, it, expect } from 'vitest';
import { resolveTie, compareRuleIdentity } from '../../src/engine/resolveTie.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { makeRule } from '../helpers.js';

describe('resolveTie', () => {
  const tied = [
    makeRule({ id: 'b', model: 'm', priority: 500, version: 2 }),
    makeRule({ id: 'a', model: 'm', priority: 500, version: 1 }),
    makeRule({ id: 'c', model: 'm', priority: 500 }),
  ];

  it("throws RuleConflictError naming every tied id in 'throw' mode", () => {
    try {
      resolveTie(tied, 'throw');
      expect.unreachable('should have thrown');
    } catch (e) {
      if (!(e instanceof RuleConflictError)) throw e;
      expect(e.ruleIds).toEqual(['a', 'b', 'c']);
      expect(e.priority).toBe(500);
    }
  });

  it("keeps the smallest id in 'first' mode and skips the others with RULE_CONFLICT", () => {
    const { winner, losers } = resolveTie(tied, 'first');
    expect(winner.id).toBe('a');
    expect(losers.map((l) => l.rule.id)).toEqual(['b', 'c']);
    expect(losers.map((l) => l.reason)).toEqual(['RULE_CONFLICT', 'RULE_CONFLICT']);
    expect(losers[0]!.detail).toBe('tied with a@1 at priority 500; the lowest id@version wins');
  });

  it('orders identities by id (code units) then version ascending', () => {
    const rules = [
      makeRule({ id: 'b', model: 'm', version: 1 }),
      makeRule({ id: 'a', model: 'm', version: 2 }),
      makeRule({ id: 'B', model: 'm', version: 1 }),
      makeRule({ id: 'a', model: 'm', version: 1 }),
    ];
    expect([...rules].sort(compareRuleIdentity).map((r) => `${r.id}@${r.version}`)).toEqual([
      'B@1',
      'a@1',
      'a@2',
      'b@1',
    ]);
  });

  it('picks the lowest version of the same id, whatever the input order', () => {
    const v2 = makeRule({ id: 'a', model: 'm', priority: 7, version: 2 });
    const v1 = makeRule({ id: 'a', model: 'm', priority: 7, version: 1 });
    for (const input of [
      [v2, v1],
      [v1, v2],
    ]) {
      const { winner, losers } = resolveTie(input, 'first');
      expect(winner.version).toBe(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.rule.version).toBe(2);
      expect(losers[0]!.detail).toBe('tied with a@1 at priority 7; the lowest id@version wins');
    }
  });

  it('throws a plain Error naming the ids when priorities differ', () => {
    const mixed = [
      makeRule({ id: 'x', model: 'm', priority: 1 }),
      makeRule({ id: 'y', model: 'm', priority: 2 }),
    ];
    expect(() => resolveTie(mixed, 'first')).toThrow(
      'resolveTie requires rules sharing one priority: x, y',
    );
    expect(() => resolveTie(mixed, 'first')).not.toThrow(RuleConflictError);
  });
});
