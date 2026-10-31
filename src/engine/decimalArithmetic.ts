import Decimal from 'decimal.js';
import { SpecError, toCanonicalDecimal } from '@run-iq/spec';
import type { JsonValue, OutputRounding, RoundingMode } from '@run-iq/spec';

/**
 * The most digits a decimal handled by the engine may span, from its highest to its lowest
 * position, the units included (`decimalSpan`).
 */
export const DECIMAL_DIGITS_LIMIT = 1000;

/**
 * The decimal.js constructors of the engine, cloned from decimal.js's defaults
 * (`defaults: true`), so that the global `Decimal`, which the host may configure before or
 * after core loads (`minE`, `maxE`, `precision`, `crypto`...), is neither read nor changed.
 * No exponent notation.
 */
const SETTINGS: Decimal.Config = {
  defaults: true,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
};
/**
 * For exact values. Its precision of 20 is never applied: only construction, comparison and
 * `toDecimalPlaces` are done with it, and none of them rounds to the precision (the latter
 * rounds to its own number of places). Sums use a clone sized to their operands instead.
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
 * The positions a canonical decimal spans, from its highest to its lowest, the units included:
 * its length without sign and point (`"1000"` spans 4, `"-0.0012"` 5, `"12.5"` 3, `"0"` 1).
 * Computed on the text, without parsing it.
 */
export function decimalSpan(canonical: string): number {
  const sign = canonical.startsWith('-') ? 1 : 0;
  const point = canonical.includes('.') ? 1 : 0;
  return canonical.length - sign - point;
}

/**
 * The exact sum of decimals. The precision is sized to the operands: every digit of every
 * partial sum lies between the highest digit of the operands plus one per power of ten of their
 * count and their lowest digit, so no partial sum is rounded, whatever the order of the
 * operands. The caller holds the result to `DECIMAL_DIGITS_LIMIT`.
 */
export function exactSum(values: readonly string[]): Decimal {
  // With operands held to DECIMAL_DIGITS_LIMIT, the precision is at most about twice the limit
  // plus the digits of their count.
  const terms = values.map(exact).filter((term) => !term.isZero());
  let highest = -Infinity;
  let lowest = Infinity;
  for (const term of terms) {
    highest = Math.max(highest, term.e);
    lowest = Math.min(lowest, term.e - term.sd() + 1);
  }
  if (terms.length === 0) return new Exact(0);
  const Sized = Decimal.clone({
    ...SETTINGS,
    precision: highest + String(terms.length).length - lowest + 1,
  });
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
