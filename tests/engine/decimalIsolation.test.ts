import { describe, it, expect, vi, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import type { OutputDeclaration } from '@run-iq/spec';
import { makeRule } from '../helpers.js';

const DEFAULTS = {
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -7,
  toExpPos: 21,
  minE: -9e15,
  maxE: 9e15,
  modulo: Decimal.ROUND_DOWN,
  crypto: false,
};

describe('decimal.js isolation', () => {
  afterEach(() => {
    Decimal.set(DEFAULTS);
  });

  it('ignores global settings a host made before core loaded, and leaves them as they were', async () => {
    Decimal.set({ maxE: 20, minE: -5, precision: 3, rounding: 1, toExpPos: 2, toExpNeg: -2 });
    vi.resetModules();
    const { OutputCombiner } = await import('../../src/engine/OutputCombiner.js');
    const value = (declaration: OutputDeclaration, values: (string | number)[]): unknown =>
      OutputCombiner.combine(
        'o',
        declaration,
        values.map((v, i) => ({ rule: makeRule({ id: `r${i}`, model: 'm' }), value: v })),
        'throw',
      ).output?.value;

    expect(value({ type: 'decimal', combine: 'sum' }, [`1${'0'.repeat(30)}`, '1'])).toBe(
      `1${'0'.repeat(29)}1`,
    );
    expect(
      value({ type: 'decimal', combine: 'sum', rounding: { scale: 8, mode: 'up' } }, [
        '0.000000011',
      ]),
    ).toBe('0.00000002');
    expect(
      value({ type: 'number', combine: 'max', rounding: { scale: 2, mode: 'halfUp' } }, [1e25, 1]),
    ).toBe(1e25);
    expect(value({ type: 'number', combine: 'sum' }, [0.1, 0.2])).toBe(0.3);
    expect([Decimal.maxE, Decimal.minE, Decimal.precision, Decimal.rounding]).toEqual([
      20, -5, 3, 1,
    ]);
  });
});
