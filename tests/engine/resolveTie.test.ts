import { describe, it, expect } from 'vitest';
import { resolveTie } from '../../src/engine/resolveTie.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { makeRule } from '../helpers.js';

describe('resolveTie', () => {
  const tied = [
    makeRule({ id: 'b', model: 'M', priority: 500, version: 2 }),
    makeRule({ id: 'a', model: 'M', priority: 500, version: 1 }),
    makeRule({ id: 'c', model: 'M', priority: 500 }),
  ];

  it("throws RuleConflictError naming every tied id in 'throw' mode", () => {
    try {
      resolveTie(tied, 'throw');
      expect.unreachable('should have thrown');
    } catch (e) {
      if (!(e instanceof RuleConflictError)) throw e;
      expect(e.ruleIds).toEqual(['b', 'a', 'c']);
      expect(e.priority).toBe(500);
    }
  });

  it("keeps the smallest id in 'first' mode and skips the others with RULE_CONFLICT", () => {
    const { winner, losers } = resolveTie(tied, 'first');
    expect(winner.id).toBe('a');
    expect(losers.map((l) => l.rule.id)).toEqual(['b', 'c']);
    expect(losers.map((l) => l.reason)).toEqual(['RULE_CONFLICT', 'RULE_CONFLICT']);
    expect(losers[0]!.detail).toBe('tied with a@1 at priority 500; the smallest id wins');
  });
});
