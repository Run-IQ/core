import { describe, it, expect } from 'vitest';
import { normalizeMeta } from '../../src/input/normalizeMeta.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import type { EvaluationInput } from '../../src/types/input.js';

type Meta = EvaluationInput['meta'];
const DATE_MESSAGE =
  'a reference date must be a Date, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS[.sss] with Z or ±HH:MM, in the years 0000 to 9999; got';

const refusal = (meta: Meta): ValidationError => {
  try {
    normalizeMeta(meta);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  return expect.unreachable('should have thrown');
};

describe('normalizeMeta', () => {
  it('gives the canonical form of a bare meta: everything present, nothing in it', () => {
    expect(normalizeMeta({ tenantId: 't' })).toEqual({
      tenantId: 't',
      dates: {},
      tags: [],
      dimensions: {},
      context: {},
      assertions: {},
    });
  });

  it('writes meta.effectiveDate as the canonical instant of dates.effective', () => {
    const meta: Meta = { tenantId: 't', effectiveDate: new Date('2026-01-01T00:00:00Z') };
    expect(normalizeMeta(meta).dates).toEqual({ effective: '2026-01-01T00:00:00.000Z' });
  });

  it('writes an offset date as the canonical instant, and keeps a civil date civil', () => {
    const dates = normalizeMeta({
      tenantId: 't',
      dates: {
        effective: '2026-01-01T01:00:00+01:00',
        facture: new Date('2025-12-31T23:59:59.999Z'),
        naissance: '1990-05-05',
      },
    }).dates;
    expect(dates).toEqual({
      effective: '2026-01-01T00:00:00.000Z',
      facture: '2025-12-31T23:59:59.999Z',
      naissance: '1990-05-05',
    });
  });

  it('accepts meta.effectiveDate and meta.dates.effective that name the same instant', () => {
    const meta: Meta = {
      tenantId: 't',
      effectiveDate: new Date('2026-01-01T00:00:00Z'),
      dates: { effective: '2026-01-01T01:00:00+01:00' },
    };
    expect(normalizeMeta(meta).dates).toEqual({ effective: '2026-01-01T00:00:00.000Z' });
  });

  it('refuses meta.effectiveDate and meta.dates.effective that differ', () => {
    const error = refusal({
      tenantId: 't',
      effectiveDate: new Date('2026-01-01T00:00:00Z'),
      dates: { effective: '2026-01-02' },
    });
    expect(error.message).toBe('Invalid evaluation input');
    expect(error.reasons).toEqual(['meta.effectiveDate and meta.dates.effective differ']);
  });

  it('refuses a date that is not a date, naming it', () => {
    const error = refusal({
      tenantId: 't',
      dates: { effective: '2026-13-01', facture: '2026-01-01T00:00:00' },
    });
    expect(error.reasons).toEqual([
      `meta.dates.effective: ${DATE_MESSAGE} "2026-13-01"`,
      `meta.dates.facture: ${DATE_MESSAGE} "2026-01-01T00:00:00"`,
    ]);
    expect(refusal({ tenantId: 't', effectiveDate: new Date('x') }).reasons).toEqual([
      `meta.effectiveDate: ${DATE_MESSAGE} an invalid Date`,
    ]);
  });

  it('sorts and deduplicates dimension values, and writes a single value as a string', () => {
    const dimensions = normalizeMeta({
      tenantId: 't',
      dimensions: { pays: ['US', 'FR', 'US'], zone: ['FR'], mono: 'TG', vide: [] },
    }).dimensions;
    expect(dimensions).toEqual({ pays: ['FR', 'US'], zone: 'FR', mono: 'TG', vide: [] });
  });

  it('sorts dimension values by UTF-16 code unit, not by locale', () => {
    const { dimensions } = normalizeMeta({
      tenantId: 't',
      dimensions: { k: ['b', 'B', 'a', 'é'] },
    });
    expect(dimensions).toEqual({ k: ['B', 'a', 'b', 'é'] });
  });

  it('sorts and deduplicates tags', () => {
    expect(normalizeMeta({ tenantId: 't', tags: ['b', 'a', 'b'] }).tags).toEqual(['a', 'b']);
  });

  it('keeps the context and the assertions it was given', () => {
    const context = { note: 'x' };
    const assertions: NonNullable<Meta['assertions']> = {
      '/revenue/total': {
        by: 'agent-1',
        method: 'declared',
        at: '2026-01-01',
        status: 'validated',
      },
    };
    const meta = normalizeMeta({ tenantId: 't', context, assertions });
    expect(meta.context).toEqual({ note: 'x' });
    expect(meta.assertions).toBe(assertions);
  });

  it('does not modify the meta of the caller, frozen or not', () => {
    const meta: Meta = {
      tenantId: 't',
      tags: Object.freeze(['b', 'a', 'b']),
      effectiveDate: new Date('2026-01-01T00:00:00Z'),
      dates: Object.freeze({ facture: '2025-01-01T01:00:00+01:00' }),
      dimensions: Object.freeze({ pays: Object.freeze(['US', 'FR', 'US']) }),
    };
    const before = JSON.stringify(meta);
    const beforeDate = meta.effectiveDate?.getTime();
    normalizeMeta(meta);
    expect(JSON.stringify(meta)).toBe(before);
    expect(meta.effectiveDate?.getTime()).toBe(beforeDate);
    expect(meta.tags).toEqual(['b', 'a', 'b']);
  });
});
