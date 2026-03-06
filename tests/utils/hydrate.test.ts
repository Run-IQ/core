import { describe, it, expect } from 'vitest';
import { hydrateRule, hydrateRules } from '../../src/utils/hydrate.js';

describe('hydrateRule', () => {
  it('converts effectiveFrom string to Date', () => {
    const raw = {
      id: 'r1',
      version: 1,
      model: 'FLAT_RATE',
      params: {},
      priority: 100,
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      effectiveUntil: null,
      tags: [],
      checksum: 'abc',
    };

    const rule = hydrateRule(raw);
    expect(rule.effectiveFrom).toBeInstanceOf(Date);
    expect(rule.effectiveFrom.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(rule.effectiveUntil).toBeNull();
  });

  it('converts effectiveUntil string to Date when present', () => {
    const raw = {
      id: 'r2',
      version: 1,
      model: 'FLAT_RATE',
      params: {},
      priority: 100,
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      effectiveUntil: '2025-12-31T23:59:59.999Z',
      tags: [],
      checksum: 'abc',
    };

    const rule = hydrateRule(raw);
    expect(rule.effectiveUntil).toBeInstanceOf(Date);
    expect(rule.effectiveUntil!.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });

  it('preserves all other fields', () => {
    const raw = {
      id: 'r3',
      version: 2,
      model: 'BRACKET',
      params: { rate: 0.15 },
      priority: 200,
      effectiveFrom: '2024-06-01T00:00:00.000Z',
      effectiveUntil: null,
      tags: ['tax', 'national'],
      checksum: 'def',
      condition: { dsl: 'jsonlogic', value: { '==': [1, 1] } },
    };

    const rule = hydrateRule(raw);
    expect(rule.id).toBe('r3');
    expect(rule.version).toBe(2);
    expect(rule.model).toBe('BRACKET');
    expect(rule.params).toEqual({ rate: 0.15 });
    expect(rule.tags).toEqual(['tax', 'national']);
  });
});

describe('hydrateRules', () => {
  it('hydrates an array of raw rules', () => {
    const rawRules = [
      {
        id: 'r1',
        version: 1,
        model: 'A',
        params: {},
        priority: 100,
        effectiveFrom: '2024-01-01T00:00:00.000Z',
        effectiveUntil: null,
        tags: [],
        checksum: 'a',
      },
      {
        id: 'r2',
        version: 1,
        model: 'B',
        params: {},
        priority: 100,
        effectiveFrom: '2024-06-01T00:00:00.000Z',
        effectiveUntil: '2025-06-01T00:00:00.000Z',
        tags: [],
        checksum: 'b',
      },
    ];

    const rules = hydrateRules(rawRules);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.effectiveFrom).toBeInstanceOf(Date);
    expect(rules[1]!.effectiveUntil).toBeInstanceOf(Date);
  });
});
