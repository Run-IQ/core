import { describe, it, expect } from 'vitest';
import { hydrateRule, hydrateRules } from '../../src/utils/hydrate.js';
import { ValidationError } from '../../src/errors/ValidationError.js';

/** A valid raw rule object used as a baseline for tests. */
function validRaw(): Record<string, unknown> {
  return {
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
}

describe('hydrateRule', () => {
  // ── Happy path ──────────────────────────────────────────────────

  it('converts effectiveFrom string to Date', () => {
    const rule = hydrateRule(validRaw());
    expect(rule.effectiveFrom).toBeInstanceOf(Date);
    expect(rule.effectiveFrom.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(rule.effectiveUntil).toBeNull();
  });

  it('converts effectiveUntil string to Date when present', () => {
    const raw = validRaw();
    raw.effectiveUntil = '2025-12-31T23:59:59.999Z';

    const rule = hydrateRule(raw);
    expect(rule.effectiveUntil).toBeInstanceOf(Date);
    expect(rule.effectiveUntil!.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });

  it('preserves all other fields', () => {
    const raw = validRaw();
    raw.id = 'r3';
    raw.version = 2;
    raw.model = 'BRACKET';
    raw.params = { rate: 0.15 };
    raw.priority = 200;
    raw.effectiveFrom = '2024-06-01T00:00:00.000Z';
    raw.tags = ['tax', 'national'];
    raw.checksum = 'def';
    raw.condition = { dsl: 'jsonlogic', value: { '==': [1, 1] } };

    const rule = hydrateRule(raw);
    expect(rule.id).toBe('r3');
    expect(rule.version).toBe(2);
    expect(rule.model).toBe('BRACKET');
    expect(rule.params).toEqual({ rate: 0.15 });
    expect(rule.tags).toEqual(['tax', 'national']);
  });

  // ── Validation: rule.id ─────────────────────────────────────────

  it('throws ValidationError when id is missing', () => {
    const raw = validRaw();
    delete raw.id;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
    expect(() => hydrateRule(raw)).toThrow('rule.id must be a string');
  });

  it('throws ValidationError when id is a number', () => {
    const raw = validRaw();
    raw.id = 42;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError when id is null', () => {
    const raw = validRaw();
    raw.id = null;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  // ── Validation: rule.model ──────────────────────────────────────

  it('throws ValidationError when model is missing', () => {
    const raw = validRaw();
    delete raw.model;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
    expect(() => hydrateRule(raw)).toThrow('rule.model must be a string');
  });

  it('throws ValidationError when model is a number', () => {
    const raw = validRaw();
    raw.model = 123;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError when model is undefined', () => {
    const raw = validRaw();
    raw.model = undefined;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  // ── Validation: rule.priority ───────────────────────────────────

  it('throws ValidationError when priority is missing', () => {
    const raw = validRaw();
    delete raw.priority;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
    expect(() => hydrateRule(raw)).toThrow('rule.priority must be a number');
  });

  it('throws ValidationError when priority is a string', () => {
    const raw = validRaw();
    raw.priority = 'high';

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError when priority is null', () => {
    const raw = validRaw();
    raw.priority = null;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  // ── Validation: rule.version ────────────────────────────────────

  it('throws ValidationError when version is missing', () => {
    const raw = validRaw();
    delete raw.version;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
    expect(() => hydrateRule(raw)).toThrow('rule.version must be a number');
  });

  it('throws ValidationError when version is a string', () => {
    const raw = validRaw();
    raw.version = '1';

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError when version is null', () => {
    const raw = validRaw();
    raw.version = null;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  // ── Validation: rule.checksum ───────────────────────────────────

  it('throws ValidationError when checksum is missing', () => {
    const raw = validRaw();
    delete raw.checksum;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
    expect(() => hydrateRule(raw)).toThrow('rule.checksum must be a string');
  });

  it('throws ValidationError when checksum is a number', () => {
    const raw = validRaw();
    raw.checksum = 12345;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError when checksum is null', () => {
    const raw = validRaw();
    raw.checksum = null;

    expect(() => hydrateRule(raw)).toThrow(ValidationError);
  });

  // ── Validation: error instance has correct reasons ──────────────

  it('ValidationError includes reasons array with the validation message', () => {
    const raw = validRaw();
    delete raw.id;

    try {
      hydrateRule(raw);
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.reasons).toEqual(['rule.id must be a string']);
      expect(ve.code).toBe('VALIDATION_ERROR');
    }
  });

  // ── Validation order: first failing field wins ──────────────────

  it('throws for id before checking other fields', () => {
    // All required fields are invalid — id check should fire first
    const raw: Record<string, unknown> = {
      params: {},
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      effectiveUntil: null,
      tags: [],
    };

    expect(() => hydrateRule(raw)).toThrow('rule.id must be a string');
  });

  it('throws for model when id is valid but model is missing', () => {
    const raw: Record<string, unknown> = {
      id: 'valid-id',
      params: {},
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      effectiveUntil: null,
      tags: [],
    };

    expect(() => hydrateRule(raw)).toThrow('rule.model must be a string');
  });

  it('throws for priority when id and model are valid but priority is missing', () => {
    const raw: Record<string, unknown> = {
      id: 'valid-id',
      model: 'FLAT_RATE',
      params: {},
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      effectiveUntil: null,
      tags: [],
    };

    expect(() => hydrateRule(raw)).toThrow('rule.priority must be a number');
  });

  it('throws for version when id, model, and priority are valid but version is missing', () => {
    const raw: Record<string, unknown> = {
      id: 'valid-id',
      model: 'FLAT_RATE',
      priority: 100,
      params: {},
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      effectiveUntil: null,
      tags: [],
    };

    expect(() => hydrateRule(raw)).toThrow('rule.version must be a number');
  });

  it('throws for checksum when all other required fields are valid but checksum is missing', () => {
    const raw: Record<string, unknown> = {
      id: 'valid-id',
      model: 'FLAT_RATE',
      priority: 100,
      version: 1,
      params: {},
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      effectiveUntil: null,
      tags: [],
    };

    expect(() => hydrateRule(raw)).toThrow('rule.checksum must be a string');
  });

  // ── Edge cases for effectiveUntil ───────────────────────────────

  it('sets effectiveUntil to null when raw value is undefined', () => {
    const raw = validRaw();
    raw.effectiveUntil = undefined;

    const rule = hydrateRule(raw);
    expect(rule.effectiveUntil).toBeNull();
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

  it('returns empty array for empty input', () => {
    const rules = hydrateRules([]);
    expect(rules).toEqual([]);
  });

  it('throws ValidationError if any rule in the array is invalid', () => {
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
        // missing id → should throw
        version: 1,
        model: 'B',
        params: {},
        priority: 100,
        effectiveFrom: '2024-06-01T00:00:00.000Z',
        effectiveUntil: null,
        tags: [],
        checksum: 'b',
      } as Record<string, unknown>,
    ];

    expect(() => hydrateRules(rawRules)).toThrow(ValidationError);
  });
});
