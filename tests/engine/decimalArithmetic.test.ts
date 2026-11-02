import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import type { RoundingMode } from '@run-iq/spec';
import {
  DECIMAL_DIGITS_LIMIT,
  compareNumeric,
  decimalText,
  exactSum,
  floatSum,
  readDecimal,
  roundDecimal,
  roundNumber,
  decimalSpan,
} from '../../src/engine/decimalArithmetic.js';

/** decimal.js's own constant for each mode, written independently of the implementation. */
const DECIMAL_JS: Readonly<Record<RoundingMode, Decimal.Rounding>> = {
  halfUp: Decimal.ROUND_HALF_UP,
  halfDown: Decimal.ROUND_HALF_DOWN,
  halfEven: Decimal.ROUND_HALF_EVEN,
  up: Decimal.ROUND_UP,
  down: Decimal.ROUND_DOWN,
  ceiling: Decimal.ROUND_CEIL,
  floor: Decimal.ROUND_FLOOR,
};

const MODES: readonly RoundingMode[] = [
  'halfUp',
  'halfDown',
  'halfEven',
  'up',
  'down',
  'ceiling',
  'floor',
];

/** Expected results, in the order of MODES. */
const TABLE: readonly { value: string; scale: number; expected: readonly string[] }[] = [
  { value: '2.5', scale: 0, expected: ['3', '2', '2', '3', '2', '3', '2'] },
  { value: '-2.5', scale: 0, expected: ['-3', '-2', '-2', '-3', '-2', '-2', '-3'] },
  { value: '3.5', scale: 0, expected: ['4', '3', '4', '4', '3', '4', '3'] },
  { value: '2.45', scale: 0, expected: ['2', '2', '2', '3', '2', '3', '2'] },
  { value: '-2.45', scale: 0, expected: ['-2', '-2', '-2', '-3', '-2', '-2', '-3'] },
  { value: '0.5', scale: 0, expected: ['1', '0', '0', '1', '0', '1', '0'] },
  { value: '-0.5', scale: 0, expected: ['-1', '0', '0', '-1', '0', '0', '-1'] },
  { value: '2.5', scale: 1, expected: ['2.5', '2.5', '2.5', '2.5', '2.5', '2.5', '2.5'] },
  { value: '-2.5', scale: 1, expected: ['-2.5', '-2.5', '-2.5', '-2.5', '-2.5', '-2.5', '-2.5'] },
  { value: '2.45', scale: 1, expected: ['2.5', '2.4', '2.4', '2.5', '2.4', '2.5', '2.4'] },
  { value: '-2.45', scale: 1, expected: ['-2.5', '-2.4', '-2.4', '-2.5', '-2.4', '-2.4', '-2.5'] },
  { value: '2.35', scale: 1, expected: ['2.4', '2.3', '2.4', '2.4', '2.3', '2.4', '2.3'] },
  { value: '0.5', scale: 1, expected: ['0.5', '0.5', '0.5', '0.5', '0.5', '0.5', '0.5'] },
  { value: '-0.5', scale: 1, expected: ['-0.5', '-0.5', '-0.5', '-0.5', '-0.5', '-0.5', '-0.5'] },
];

/** The canonical text of an exact sum. */
const sumText = (values: readonly string[]): string => decimalText(exactSum(values));

describe('decimalArithmetic', () => {
  describe('rounding modes', () => {
    for (const { value, scale, expected } of TABLE) {
      MODES.forEach((mode, i) => {
        it(`rounds ${value} to ${scale} places ${mode} like decimal.js`, () => {
          const reference = new Decimal(value).toDecimalPlaces(scale, DECIMAL_JS[mode]);
          expect(decimalText(reference)).toBe(expected[i]);
          expect(roundDecimal(value, { scale, mode })).toBe(expected[i]);
          expect(roundNumber(Number(value), { scale, mode })).toBe(Number(expected[i]));
        });
      });
    }

    it('never gives -0 for a number', () => {
      expect(Object.is(roundNumber(-0.4, { scale: 0, mode: 'halfUp' }), 0)).toBe(true);
      expect(Object.is(roundNumber(-0.5, { scale: 0, mode: 'down' }), 0)).toBe(true);
      expect(roundDecimal('-0.4', { scale: 0, mode: 'halfUp' })).toBe('0');
    });

    it('rounds to 20 places and to 0', () => {
      expect(roundDecimal('0.123456789012345678905', { scale: 20, mode: 'halfUp' })).toBe(
        '0.12345678901234567891',
      );
      expect(roundDecimal('0.123456789012345678905', { scale: 20, mode: 'halfDown' })).toBe(
        '0.1234567890123456789',
      );
      expect(roundDecimal('123456789012345678901234567890.5', { scale: 0, mode: 'up' })).toBe(
        '123456789012345678901234567891',
      );
      expect(roundNumber(0.1, { scale: 20, mode: 'up' })).toBe(0.1);
      expect(roundNumber(1.005, { scale: 2, mode: 'halfUp' })).toBe(1.01);
    });
  });

  describe('readDecimal', () => {
    it('gives the canonical form of a decimal string or a safe integer', () => {
      expect(readDecimal('0012.50')).toBe('12.5');
      expect(readDecimal('-0.0')).toBe('0');
      expect(readDecimal(12)).toBe('12');
      expect(readDecimal(-0)).toBe('0');
      expect(readDecimal(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    });

    it('refuses a fractional or unsafe number, an exponent, text and other values', () => {
      for (const value of [0.1, 2 ** 53, '1e3', 'abc', '.5', '', null, true, ['1'], { v: '1' }]) {
        expect(readDecimal(value)).toBeUndefined();
      }
    });
  });

  describe('exactSum', () => {
    it('adds without loss', () => {
      expect(sumText(['0.1', '0.2'])).toBe('0.3');
      expect(sumText(['99999999999999999999999.99', '0.01'])).toBe('100000000000000000000000');
      expect(sumText(Array.from({ length: 10_000 }, () => '0.01'))).toBe('100');
      expect(sumText([])).toBe('0');
      expect(sumText(['0', '-5', '5'])).toBe('0');
    });

    it('stays exact beyond the limit: the combiner holds results to it', () => {
      const big = `1${'0'.repeat(DECIMAL_DIGITS_LIMIT - 1)}`; // 1000 integer digits
      expect(sumText([big, '0.1'])).toBe(`${big}.1`);
      expect(sumText([big, '0.1', `-${big}`])).toBe('0.1');
    });

    it('uses its own decimal.js constructor: the global configuration changes nothing', () => {
      const saved = Decimal.precision;
      try {
        Decimal.set({ precision: 5 });
        expect(sumText(['123456789.123', '0.001'])).toBe('123456789.124');
        expect(floatSum([1e20, 1, -1e20]).toNumber()).toBe(0);
      } finally {
        Decimal.set({ precision: saved });
      }
      exactSum(['1', '2']);
      expect(Decimal.precision).toBe(saved);
    });
  });

  describe('decimalSpan', () => {
    it('counts the positions from the highest to the lowest, the units included', () => {
      expect(DECIMAL_DIGITS_LIMIT).toBe(1000);
      expect(decimalSpan('0')).toBe(1);
      expect(decimalSpan('12.5')).toBe(3);
      expect(decimalSpan('-0.0012')).toBe(5);
      expect(decimalSpan('1000')).toBe(4);
      expect(decimalSpan(`1${'0'.repeat(999)}.1`)).toBe(1001);
      expect(decimalSpan(`0.${'0'.repeat(1_000_000)}1`)).toBe(1_000_002);
    });
  });

  describe('rounding to an increment, or with no step', () => {
    // Each expectation worked out by hand: value / increment, rounded to an integer in the mode,
    // times the increment. 1.075 and 1.025 are ties of 0.05 (21.5 and 20.5 steps).
    const cases: ReadonlyArray<readonly [string, string, RoundingMode, string]> = [
      ['1.07', '0.05', 'halfUp', '1.05'],
      ['1.07', '0.05', 'up', '1.1'],
      ['1.07', '0.05', 'down', '1.05'],
      ['1.07', '0.05', 'ceiling', '1.1'],
      ['1.07', '0.05', 'floor', '1.05'],
      ['1.075', '0.05', 'halfUp', '1.1'],
      ['1.075', '0.05', 'halfDown', '1.05'],
      ['1.075', '0.05', 'halfEven', '1.1'],
      ['1.025', '0.05', 'halfUp', '1.05'],
      ['1.025', '0.05', 'halfDown', '1'],
      ['1.025', '0.05', 'halfEven', '1'],
      ['-1.075', '0.05', 'halfUp', '-1.1'],
      ['-1.075', '0.05', 'halfDown', '-1.05'],
      ['-1.075', '0.05', 'halfEven', '-1.1'],
      ['-1.075', '0.05', 'up', '-1.1'],
      ['-1.075', '0.05', 'down', '-1.05'],
      ['-1.075', '0.05', 'ceiling', '-1.05'],
      ['-1.075', '0.05', 'floor', '-1.1'],
      ['14', '10', 'halfUp', '10'],
      ['15', '10', 'halfUp', '20'],
      ['25', '10', 'halfEven', '20'],
      ['35', '10', 'halfEven', '40'],
      ['10', '3', 'halfUp', '9'],
      ['11', '3', 'halfUp', '12'],
      ['11', '3', 'floor', '9'],
      ['11', '3', 'ceiling', '12'],
      ['0.04', '0.05', 'down', '0'],
    ];

    it.each(cases)('%s to the increment %s, %s: %s', (value, increment, mode, expected) => {
      expect(roundDecimal(value, { increment, mode })).toBe(expected);
      expect(roundNumber(Number(value), { increment, mode })).toBe(Number(expected));
    });

    it('is exact past 20 significant digits', () => {
      const big = `${'9'.repeat(40)}.5`;
      expect(roundDecimal(big, { increment: '1', mode: 'halfUp' })).toBe(`1${'0'.repeat(40)}`);
      expect(roundDecimal(`${'9'.repeat(40)}.4`, { increment: '0.5', mode: 'halfUp' })).toBe(
        `${'9'.repeat(40)}.5`,
      );
    });

    it('never gives -0', () => {
      expect(Object.is(roundNumber(-0.01, { increment: '0.05', mode: 'halfUp' }), 0)).toBe(true);
    });

    it('leaves a value as it is when the rounding has no scale and no increment', () => {
      expect(roundDecimal('1.234', { mode: 'halfUp' })).toBe('1.234');
      expect(roundNumber(1.234, { mode: 'halfUp' })).toBe(1.234);
    });
  });

  describe('floatSum and compareNumeric', () => {
    it('sums numbers in Decimal to 20 significant digits, as before', () => {
      expect(floatSum([0.1, 0.2]).toNumber()).toBe(0.3);
      expect(floatSum([1e20, 1, -1e20]).toNumber()).toBe(0);
    });

    it('compares numbers and decimals exactly', () => {
      expect(compareNumeric('12345678901234567890.2', '12345678901234567890.1')).toBe(1);
      expect(compareNumeric('-1', '0')).toBe(-1);
      expect(compareNumeric(0.30000000000000004, 0.3)).toBe(1);
      expect(compareNumeric('2.50', '2.5')).toBe(0);
    });
  });
});
