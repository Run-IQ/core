import Decimal from 'decimal.js';
import { SpecError, toCanonicalDecimal } from '@run-iq/spec';
import type { JsonValue, OutputRounding, RoundingMode } from '@run-iq/spec';

/** The most significant digits a decimal handled by the engine may have. */
export const DECIMAL_DIGITS_LIMIT = 1000;

/**
 * The decimal.js constructors of the engine, cloned so that the global `Decimal`, which other
 * code in the process may configure, is neither read nor changed. No exponent notation.
 */
const SETTINGS: Decimal.Config = {
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
};
/**
 * For exact values: no operation made with it rounds to its precision (construction,
 * comparison, `toDecimalPlaces`); sums use a clone sized to their operands.
 */
const Exact = Decimal.clone({ ...SETTINGS, precision: 20 });
/** For `number` sums: 20 significant digits, as before decimals. */
const Float = Decimal.clone({ ...SETTINGS, precision: 20 });

/** decimal.js's rounding for each mode: the only place the seven modes are implemented. */
const ROUNDING: Readonly<Record<RoundingMode, Decimal.Rounding>> = {
  halfUp: Decimal.ROUND_HALF_UP,
  halfDown: Decimal.ROUND_HALF_DOWN,
  halfEven: Decimal.ROUND_HALF_EVEN,
  up: Decimal.ROUND_UP,
  down: Decimal.ROUND_DOWN,
  ceiling: Decimal.ROUND_CEIL,
  floor: Decimal.ROUND_FLOOR,
};

/** A finite number or a decimal string, as `number` and `decimal` outputs hold them. */
export type Numeric = number | string;

/** True for a finite number or a string (a `decimal` value once read). */
export const isNumeric = (value: JsonValue): value is Numeric =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** The exact value of a number (its shortest decimal writing, `String(n)`) or of a decimal. */
const exact = (value: Numeric): Decimal => new Exact(String(value));

/**
 * The canonical decimal a `decimal` contribution stands for: a decimal string (`"0012.50"`
 * gives `"12.5"`) or a safe integer (`12` gives `"12"`). `undefined` for anything else: a
 * fractional or unsafe number (no float enters an amount), an exponent (`"1e3"`), text, or a
 * value that is neither a string nor a number.
 */
export function readDecimal(value: JsonValue): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;
  try {
    return toCanonicalDecimal(value);
  } catch (e) {
    if (e instanceof SpecError && e.code === 'INVALID_DECIMAL') return undefined;
    throw e;
  }
}

/** The canonical decimal string of a value: no exponent, no trailing zero, no `-0`. */
export const decimalText = (value: Decimal): string => toCanonicalDecimal(value.toFixed());

/** The number closest to a value, `0` rather than `-0`. */
export function numberOf(value: Decimal): number {
  const n = value.toNumber();
  return n === 0 ? 0 : n;
}

/** The exact order of two values: -1, 0 or 1. */
export const compareNumeric = (a: Numeric, b: Numeric): number => exact(a).comparedTo(exact(b));

/**
 * The significant digits of a decimal, from its first to its last non-zero digit (`"1000"` has
 * 1, `"-0.00120"` has 2, `"0"` has 1), as decimal.js counts them.
 */
export const significantDigits = (value: string): number => exact(value).sd();

/**
 * The exact sum of decimals. The precision is sized to the operands: every digit of every
 * partial sum lies between the highest digit of the operands plus one per power of ten of their
 * count and their lowest digit, so no partial sum is rounded, whatever the order of the
 * operands. The caller holds the result to `DECIMAL_DIGITS_LIMIT`.
 */
export function exactSum(values: readonly string[]): Decimal {
  const terms = values.map(exact).filter((term) => !term.isZero());
  let highest = -Infinity;
  let lowest = Infinity;
  for (const term of terms) {
    highest = Math.max(highest, term.e);
    lowest = Math.min(lowest, term.e - term.sd() + 1);
  }
  if (terms.length === 0) return new Exact(0);
  const Sized = Exact.clone({ precision: highest + String(terms.length).length - lowest + 1 });
  return terms.reduce<Decimal>((total, term) => total.plus(term), new Sized(0));
}

/** The sum of numbers in Decimal to 20 significant digits (`0.1 + 0.2` is `0.3`). */
export const floatSum = (values: readonly number[]): Decimal =>
  values.reduce<Decimal>((total, value) => total.plus(String(value)), new Float(0));

/** `value` rounded to `rounding.scale` places in `rounding.mode`. */
export const round = (value: Decimal, rounding: OutputRounding): Decimal =>
  value.toDecimalPlaces(rounding.scale, ROUNDING[rounding.mode]);

/** A decimal string rounded, in canonical form. */
export const roundDecimal = (value: string, rounding: OutputRounding): string =>
  decimalText(round(exact(value), rounding));

/**
 * A number rounded in Decimal from its shortest writing (`1.005` to 2 places `halfUp` gives
 * `1.01`), then converted back to a number; never `-0`.
 */
export const roundNumber = (value: number, rounding: OutputRounding): number =>
  numberOf(round(exact(value), rounding));
