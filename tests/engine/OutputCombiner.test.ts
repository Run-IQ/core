import { describe, it, expect } from 'vitest';
import type { JsonValue, OutputDeclaration, OutputRounding, RoundingMode } from '@run-iq/spec';
import { OutputCombiner } from '../../src/engine/OutputCombiner.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { OutputNotFiniteError } from '../../src/errors/OutputNotFiniteError.js';
import { DecimalPrecisionError } from '../../src/errors/DecimalPrecisionError.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, permutations } from '../helpers.js';

const rule = (id: string, priority = 100): Rule => makeRule({ id, model: 'M', priority });
const of = (r: Rule, value: JsonValue): { rule: Rule; value: JsonValue } => ({ rule: r, value });

const NUMBER = (combine: OutputDeclaration['combine']): OutputDeclaration => ({
  type: 'number',
  combine,
});
const RISK: OutputDeclaration = {
  type: 'enum',
  combine: 'highestPriority',
  values: ['low', 'medium', 'high'],
};
const LIST: OutputDeclaration = { type: 'list', combine: 'union' };

describe('OutputCombiner', () => {
  describe('count', () => {
    const COUNT: OutputDeclaration = { type: 'number', combine: 'count' };
    const [a, b, c] = [rule('a'), rule('b'), rule('c')] as [Rule, Rule, Rule];

    it('counts the contributions that are true', () => {
      const { output, skipped } = OutputCombiner.combine(
        'flags',
        COUNT,
        [of(a, true), of(b, false), of(c, true)],
        'throw',
      );
      expect(skipped).toEqual([]);
      expect(output).toEqual({
        name: 'flags',
        type: 'number',
        combine: 'count',
        value: 2,
        contributors: ['a', 'b', 'c'],
      });
    });

    it('counts none as 0 when every contribution is false', () => {
      expect(
        OutputCombiner.combine('flags', COUNT, [of(a, false), of(b, false)], 'throw').output?.value,
      ).toBe(0);
    });

    it('refuses a contribution that is not a boolean, with OUTPUT_MISMATCH', () => {
      const { output, skipped } = OutputCombiner.combine(
        'flags',
        COUNT,
        [of(a, true), of(b, 1)],
        'throw',
      );
      expect(output?.value).toBe(1);
      expect(skipped).toEqual([
        {
          rule: b,
          reason: 'OUTPUT_MISMATCH',
          detail:
            'output flags: value 1 does not match type number: a count takes a boolean (true is counted)',
        },
      ]);
    });

    it('takes a short-circuit value as the count itself', () => {
      expect(OutputCombiner.impose('flags', COUNT, a, 3).output.value).toBe(3);
      expect(() => OutputCombiner.impose('flags', COUNT, a, true)).toThrow(
        'short-circuit of a@1 on output flags: value true does not match type number',
      );
    });
  });

  describe('max and min on enum, date and dateTime', () => {
    const [a, b, c] = [rule('a'), rule('b'), rule('c')] as [Rule, Rule, Rule];
    const RANKED: OutputDeclaration = {
      type: 'enum',
      combine: 'max',
      values: ['low', 'medium', 'high'],
    };
    const outputOf = (
      declaration: OutputDeclaration,
      values: readonly [JsonValue, JsonValue, JsonValue],
    ) =>
      OutputCombiner.combine(
        'o',
        declaration,
        [of(a, values[0]), of(b, values[1]), of(c, values[2])],
        'throw',
      );

    it('an enum is compared by rank in values, not by text', () => {
      // By text, 'low' < 'medium' < 'high' would be 'high' < 'low' < 'medium'.
      const values = ['low', 'high', 'medium'] as const;
      expect(outputOf(RANKED, values).output).toEqual({
        name: 'o',
        type: 'enum',
        combine: 'max',
        value: 'high',
        contributors: ['a', 'b', 'c'],
      });
      expect(outputOf({ ...RANKED, combine: 'min' }, values).output?.value).toBe('low');
      expect(
        outputOf({ ...RANKED, combine: 'min' }, ['high', 'medium', 'medium']).output?.value,
      ).toBe('medium');
    });

    it('a date is compared in time', () => {
      const dates = ['2025-12-31', '2026-01-01', '2025-02-28'] as const;
      const date: OutputDeclaration = { type: 'date', combine: 'max' };
      expect(outputOf(date, dates).output?.value).toBe('2026-01-01');
      expect(outputOf({ ...date, combine: 'min' }, dates).output?.value).toBe('2025-02-28');
    });

    it('a dateTime is compared in time', () => {
      const instants = [
        '2026-01-01T00:00:00.000Z',
        '2025-12-31T23:59:59.999Z',
        '2026-01-01T00:00:00.001Z',
      ] as const;
      const instant: OutputDeclaration = { type: 'dateTime', combine: 'max' };
      expect(outputOf(instant, instants).output?.value).toBe('2026-01-01T00:00:00.001Z');
      expect(outputOf({ ...instant, combine: 'min' }, instants).output?.value).toBe(
        '2025-12-31T23:59:59.999Z',
      );
    });

    it('keeps the first of equal extremes, in contribution order (-0 and 0 are equal)', () => {
      // The two values are equal for max and min but not identical: which one is kept shows
      // which contribution came first (a before b: same priority, by id).
      const sign = (v: unknown): string => (Object.is(v, -0) ? '-0' : String(v));
      const number = (combine: 'max' | 'min', first: number, second: number): string =>
        sign(
          OutputCombiner.combine(
            'o',
            { type: 'number', combine },
            [of(a, first), of(b, second)],
            'throw',
          ).output?.value,
        );
      expect(number('max', -0, 0)).toBe('-0');
      expect(number('max', 0, -0)).toBe('0');
      expect(number('min', -0, 0)).toBe('-0');
      expect(number('min', 0, -0)).toBe('0');
    });
  });

  describe('sum, max, min', () => {
    const a = rule('a');
    const b = rule('b');
    const c = rule('c');

    it('sums in Decimal: 0.1 + 0.2 is 0.3', () => {
      const { output, skipped } = OutputCombiner.combine(
        'value',
        NUMBER('sum'),
        [of(a, 0.1), of(b, 0.2)],
        'throw',
      );
      expect(skipped).toEqual([]);
      expect(output).toEqual({
        name: 'value',
        type: 'number',
        combine: 'sum',
        value: 0.3,
        contributors: ['a', 'b'],
      });
    });

    it('sums without drift over many terms', () => {
      const rules = Array.from({ length: 10 }, (_, i) => rule(`r${i}`));
      const { output } = OutputCombiner.combine(
        'value',
        NUMBER('sum'),
        rules.map((r) => of(r, 0.1)),
        'throw',
      );
      expect(output?.value).toBe(1);
    });

    it('takes the exact maximum and minimum', () => {
      const contributions = [of(a, 0.30000000000000004), of(b, 0.3), of(c, -0.1)];
      expect(OutputCombiner.combine('top', NUMBER('max'), contributions, 'throw').output).toEqual({
        name: 'top',
        type: 'number',
        combine: 'max',
        value: 0.30000000000000004,
        contributors: ['a', 'b', 'c'],
      });
      expect(
        OutputCombiner.combine('low', NUMBER('min'), contributions, 'throw').output?.value,
      ).toBe(-0.1);
    });
  });

  describe('highestPriority', () => {
    it("takes the highest priority's value; the lower ones do not contribute", () => {
      const { output, skipped } = OutputCombiner.combine(
        'risk',
        RISK,
        [of(rule('low', 100), 'low'), of(rule('high', 900), 'high')],
        'throw',
      );
      expect(skipped).toEqual([]);
      expect(output).toEqual({
        name: 'risk',
        type: 'enum',
        combine: 'highestPriority',
        value: 'high',
        contributors: ['high'],
      });
    });

    it("throws RuleConflictError on a tie with different values in 'throw' mode", () => {
      try {
        OutputCombiner.combine(
          'risk',
          RISK,
          [of(rule('b', 500), 'low'), of(rule('a', 500), 'high'), of(rule('c', 100), 'low')],
          'throw',
        );
        expect.unreachable('should have thrown');
      } catch (e) {
        if (!(e instanceof RuleConflictError)) throw e;
        expect(e.ruleIds).toEqual(['a', 'b']);
        expect(e.priority).toBe(500);
      }
    });

    it("keeps the lowest id@version on a tie in 'first' mode and skips the others", () => {
      const a = rule('a', 500);
      const b = rule('b', 500);
      const { output, skipped } = OutputCombiner.combine(
        'risk',
        RISK,
        [of(b, 'low'), of(a, 'high')],
        'first',
      );
      expect(output?.value).toBe('high');
      expect(output?.contributors).toEqual(['a']);
      expect(skipped).toEqual([
        {
          rule: b,
          reason: 'RULE_CONFLICT',
          detail: 'output risk: tied with a@1 at priority 500; the lowest id@version wins',
        },
      ]);
    });

    it('sees no conflict when the tied values are canonically equal', () => {
      const declaration: OutputDeclaration = { type: 'object', combine: 'highestPriority' };
      const { output, skipped } = OutputCombiner.combine(
        'terms',
        declaration,
        [of(rule('b', 500), { x: 1, y: [1, 2] }), of(rule('a', 500), { y: [1, 2], x: 1 })],
        'throw',
      );
      expect(skipped).toEqual([]);
      expect(output?.value).toEqual({ x: 1, y: [1, 2] });
      expect(output?.contributors).toEqual(['a', 'b']);
    });

    it("keeps the agreeing rules of a tie in 'first' mode", () => {
      const a = rule('a', 500);
      const b = rule('b', 500);
      const c = rule('c', 500);
      const { output, skipped } = OutputCombiner.combine(
        'risk',
        RISK,
        [of(c, 'high'), of(b, 'low'), of(a, 'high')],
        'first',
      );
      expect(output?.value).toBe('high');
      expect(output?.contributors).toEqual(['a', 'c']);
      expect(skipped.map((s) => [s.rule.id, s.reason])).toEqual([['b', 'RULE_CONFLICT']]);
    });
  });

  describe('union', () => {
    it('concatenates by priority descending then id, and deduplicates by canonical form', () => {
      const { output, skipped } = OutputCombiner.combine(
        'obligations',
        LIST,
        [
          of(rule('a', 100), ['x', 'y']),
          of(rule('d', 100), [{ k: 1, j: 2 }]),
          of(rule('b', 900), ['y', 'z']),
          of(rule('c', 100), [{ j: 2, k: 1 }, 'x', 'w']),
        ],
        'throw',
      );
      expect(skipped).toEqual([]);
      expect(output).toEqual({
        name: 'obligations',
        type: 'list',
        combine: 'union',
        value: ['y', 'z', 'x', { j: 2, k: 1 }, 'w'],
        contributors: ['b', 'a', 'c', 'd'],
      });
    });

    it('excludes a contribution that is not an array with OUTPUT_MISMATCH', () => {
      const bad = rule('bad');
      const { output, skipped } = OutputCombiner.combine(
        'obligations',
        LIST,
        [of(rule('a'), ['x']), of(bad, 'x')],
        'throw',
      );
      expect(output?.value).toEqual(['x']);
      expect(output?.contributors).toEqual(['a']);
      expect(skipped).toEqual([
        {
          rule: bad,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output obligations: value "x" does not match type list',
        },
      ]);
    });
  });

  describe('all and any', () => {
    const t = rule('t');
    const f = rule('f');
    const u = rule('u');

    it('combines like AND and OR', () => {
      const mixed = [of(t, true), of(f, false)];
      const allTrue = [of(t, true), of(u, true)];
      const allFalse = [of(f, false), of(u, false)];
      const all = (cs: typeof mixed): JsonValue | undefined =>
        OutputCombiner.combine('ok', { type: 'boolean', combine: 'all' }, cs, 'throw').output
          ?.value;
      const any = (cs: typeof mixed): JsonValue | undefined =>
        OutputCombiner.combine('ok', { type: 'boolean', combine: 'any' }, cs, 'throw').output
          ?.value;
      expect([all(mixed), all(allTrue), all(allFalse)]).toEqual([false, true, false]);
      expect([any(mixed), any(allTrue), any(allFalse)]).toEqual([true, true, false]);
    });
  });

  describe('values out of type', () => {
    it('excludes a value that does not match the declared type with OUTPUT_MISMATCH', () => {
      const medium = rule('m');
      const text = rule('t');
      const risk = OutputCombiner.combine(
        'risk',
        RISK,
        [of(rule('a'), 'low'), of(medium, 'severe')],
        'throw',
      );
      expect(risk.output?.value).toBe('low');
      expect(risk.skipped).toEqual([
        {
          rule: medium,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output risk: value "severe" does not match type enum (low, medium, high)',
        },
      ]);
      const sum = OutputCombiner.combine(
        'value',
        NUMBER('sum'),
        [of(rule('a'), 1), of(text, '2')],
        'throw',
      );
      expect(sum.output?.value).toBe(1);
      expect(sum.skipped).toEqual([
        {
          rule: text,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output value: value "2" does not match type number',
        },
      ]);
    });

    it('gives no output when no contribution is valid', () => {
      const { output, skipped } = OutputCombiner.combine('risk', RISK, [of(rule('a'), 3)], 'throw');
      expect(output).toBeUndefined();
      expect(skipped.map((s) => s.reason)).toEqual(['OUTPUT_MISMATCH']);
    });

    it('gives no output for no contribution', () => {
      expect(OutputCombiner.combine('value', NUMBER('sum'), [], 'throw')).toEqual({
        output: undefined,
        skipped: [],
        recorded: new Map(),
      });
    });
  });

  it('gives the same result whatever the order of the contributions', () => {
    const contributions = [
      of(rule('a', 100), ['x', 'y']),
      of(rule('b', 900), ['y', 'z']),
      of(rule('c', 100), 'bad'),
      of(rule('d', 900), ['z', 'w']),
    ];
    const expected = OutputCombiner.combine('l', LIST, contributions, 'throw');
    expect(expected.output?.value).toEqual(['y', 'z', 'w', 'x']);
    for (const order of permutations(contributions)) {
      expect(OutputCombiner.combine('l', LIST, order, 'throw')).toEqual(expected);
    }
  });

  describe('limits', () => {
    it('throws OutputNotFiniteError naming the output and its contributors in identity order', () => {
      try {
        OutputCombiner.combine(
          'tax',
          NUMBER('sum'),
          [of(rule('b', 900), 1e308), of(rule('a', 100), 1e308), of(rule('c'), 1)],
          'first',
        );
        expect.unreachable('should have thrown');
      } catch (e) {
        if (!(e instanceof OutputNotFiniteError)) throw e;
        expect(e.code).toBe('OUTPUT_NOT_FINITE');
        expect(e.output).toBe('tax');
        expect(e.contributors).toEqual(['a', 'b', 'c']);
        expect(e.message).toBe('Output tax is not a finite number; contributors: a, b, c');
      }
    });

    it('reports NaN and Infinity reaching it directly as OUTPUT_MISMATCH, without throwing', () => {
      const n = rule('n');
      const i = rule('i');
      const { output, skipped } = OutputCombiner.combine(
        'value',
        NUMBER('max'),
        [of(n, NaN), of(i, -Infinity), of(rule('a'), 3)],
        'throw',
      );
      expect(output?.value).toBe(3);
      expect(skipped).toEqual([
        {
          rule: i,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output value: value -Infinity does not match type number',
        },
        {
          rule: n,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output value: value NaN does not match type number',
        },
      ]);
    });

    it('sums exactly to 20 significant digits, whatever the order', () => {
      const contributions = [
        of(rule('a', 200), 1e20),
        of(rule('b', 100), 1),
        of(rule('c', 50), -1e20),
      ];
      for (const order of permutations(contributions)) {
        expect(OutputCombiner.combine('value', NUMBER('sum'), order, 'throw').output?.value).toBe(
          0,
        );
      }
    });

    it('throws on a combine strategy it does not know', () => {
      // A declaration that skipped registration (ModelRegistry refuses it): only a cast builds it.
      // Spec reads the declaration first and refuses it, naming the strategies it knows.
      const unknown = JSON.parse('{"type":"number","combine":"avg"}') as OutputDeclaration;
      expect(() => OutputCombiner.combine('o', unknown, [of(rule('a'), 1)], 'throw')).toThrow(
        'invalid output declaration: output.combine must be one of sum, max, min, highestPriority, union, all, any, count',
      );
    });
  });

  describe('decimal', () => {
    const DECIMAL = (
      combine: OutputDeclaration['combine'],
      rounding?: OutputRounding,
    ): OutputDeclaration =>
      rounding === undefined
        ? { type: 'decimal', combine }
        : { type: 'decimal', combine, rounding };
    const a = rule('a', 300);
    const b = rule('b', 200);
    const c = rule('c', 100);
    const sumOf = (...values: JsonValue[]): JsonValue | undefined =>
      OutputCombiner.combine(
        'amount',
        DECIMAL('sum'),
        values.map((v, i) => of(rule(`r${String(i).padStart(5, '0')}`), v)),
        'throw',
      ).output?.value;

    it('accepts a decimal string or a safe integer, in canonical form', () => {
      const { output, skipped, recorded } = OutputCombiner.combine(
        'amount',
        DECIMAL('sum'),
        [of(a, '0012.50'), of(b, 12), of(c, '-0.0')],
        'throw',
      );
      expect(skipped).toEqual([]);
      expect(output).toEqual({
        name: 'amount',
        type: 'decimal',
        combine: 'sum',
        value: '24.5',
        contributors: ['a', 'b', 'c'],
      });
      expect(recorded).toStrictEqual(
        new Map([
          [a, { value: '12.5' }],
          [b, { value: '12' }],
          [c, { value: '0' }],
        ]),
      );
    });

    it('excludes a float, an unsafe integer, an exponent or text with OUTPUT_MISMATCH', () => {
      const f = rule('f');
      const u = rule('u');
      const e = rule('e');
      const t = rule('t');
      const n = rule('n');
      const { output, skipped, recorded } = OutputCombiner.combine(
        'amount',
        DECIMAL('sum'),
        [of(f, 0.1), of(u, 2 ** 53), of(e, '1e3'), of(t, 'abc'), of(n, null), of(a, '1')],
        'throw',
      );
      expect(output?.value).toBe('1');
      expect(recorded).toStrictEqual(new Map([[a, { value: '1' }]]));
      const expected =
        'does not match type decimal: expected a decimal string (an optional "-", digits, ' +
        'an optional "." and digits, no exponent) or a safe integer';
      expect(skipped).toEqual([
        { rule: e, reason: 'OUTPUT_MISMATCH', detail: `output amount: value "1e3" ${expected}` },
        { rule: f, reason: 'OUTPUT_MISMATCH', detail: `output amount: value 0.1 ${expected}` },
        { rule: n, reason: 'OUTPUT_MISMATCH', detail: `output amount: value null ${expected}` },
        { rule: t, reason: 'OUTPUT_MISMATCH', detail: `output amount: value "abc" ${expected}` },
        {
          rule: u,
          reason: 'OUTPUT_MISMATCH',
          detail: `output amount: value 9007199254740992 ${expected}`,
        },
      ]);
    });

    it('gives no output, never null, when no contribution is a decimal', () => {
      for (const combine of ['sum', 'max', 'min', 'highestPriority'] as const) {
        const { output } = OutputCombiner.combine(
          'amount',
          DECIMAL(combine),
          [of(a, 0.5), of(b, null)],
          'throw',
        );
        expect(output).toBeUndefined();
      }
    });

    it('sums exactly', () => {
      expect(sumOf('0.1', '0.2')).toBe('0.3');
      expect(sumOf(...Array.from({ length: 10_000 }, () => '0.01'))).toBe('100');
      expect(sumOf('99999999999999999999999.99', '0.01')).toBe('100000000000000000000000');
      expect(sumOf('-5', 5)).toBe('0');
    });

    it('takes the exact maximum and minimum beyond 17 digits', () => {
      const contributions = [
        of(a, '12345678901234567890.1'),
        of(b, '12345678901234567890.2'),
        of(c, '12345678901234567890.15'),
      ];
      for (const order of permutations(contributions)) {
        expect(OutputCombiner.combine('m', DECIMAL('max'), order, 'throw').output).toEqual({
          name: 'm',
          type: 'decimal',
          combine: 'max',
          value: '12345678901234567890.2',
          contributors: ['a', 'b', 'c'],
        });
        expect(OutputCombiner.combine('m', DECIMAL('min'), order, 'throw').output?.value).toBe(
          '12345678901234567890.1',
        );
      }
    });

    it('compares canonical forms under highestPriority', () => {
      const { output, skipped } = OutputCombiner.combine(
        'rate',
        DECIMAL('highestPriority'),
        [of(rule('x', 500), '12.50'), of(rule('y', 500), '12.5')],
        'throw',
      );
      expect(skipped).toEqual([]);
      expect(output?.value).toBe('12.5');
      expect(output?.contributors).toEqual(['x', 'y']);
      expect(() =>
        OutputCombiner.combine(
          'rate',
          DECIMAL('highestPriority'),
          [of(rule('x', 500), '12.50'), of(rule('y', 500), '12.51')],
          'throw',
        ),
      ).toThrow(RuleConflictError);
    });

    it('throws DecimalPrecisionError beyond a span of 1000 digits, without a result', () => {
      const under = `1${'0'.repeat(998)}`; // 999 integer digits: 1000 with the fraction
      expect(sumOf(under, '0.1')).toBe(`${under}.1`);
      const big = `${under}0`; // 1000 integer digits: 1001 with the fraction
      try {
        sumOf(big, '0.1');
        expect.unreachable('should have thrown');
      } catch (e) {
        if (!(e instanceof DecimalPrecisionError)) throw e;
        expect(e.code).toBe('DECIMAL_PRECISION');
        expect(e.output).toBe('amount');
        expect(e.limit).toBe(1000);
        expect(e.message).toBe(
          'Output amount holds a decimal spanning more than 1000 digits: the decision is refused rather than rounded',
        );
      }
    });
  });

  describe('rounding', () => {
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
      { value: '2.45', scale: 0, expected: ['2', '2', '2', '3', '2', '3', '2'] },
      { value: '-2.45', scale: 0, expected: ['-2', '-2', '-2', '-3', '-2', '-2', '-3'] },
      { value: '0.5', scale: 0, expected: ['1', '0', '0', '1', '0', '1', '0'] },
      { value: '-0.5', scale: 0, expected: ['-1', '0', '0', '-1', '0', '0', '-1'] },
      { value: '2.5', scale: 1, expected: ['2.5', '2.5', '2.5', '2.5', '2.5', '2.5', '2.5'] },
      { value: '2.45', scale: 1, expected: ['2.5', '2.4', '2.4', '2.5', '2.4', '2.5', '2.4'] },
      {
        value: '-2.45',
        scale: 1,
        expected: ['-2.5', '-2.4', '-2.4', '-2.5', '-2.4', '-2.4', '-2.5'],
      },
      { value: '0.5', scale: 1, expected: ['0.5', '0.5', '0.5', '0.5', '0.5', '0.5', '0.5'] },
      {
        value: '-0.5',
        scale: 1,
        expected: ['-0.5', '-0.5', '-0.5', '-0.5', '-0.5', '-0.5', '-0.5'],
      },
    ];

    it("rounds the combined value in every mode at 'output' (the default), decimal and number", () => {
      for (const { value, scale, expected } of TABLE) {
        MODES.forEach((mode, i) => {
          for (const at of [undefined, 'output'] as const) {
            const rounding: OutputRounding =
              at === undefined ? { scale, mode } : { scale, mode, at };
            const decimal = OutputCombiner.combine(
              'd',
              { type: 'decimal', combine: 'sum', rounding },
              [of(rule('a'), value)],
              'throw',
            );
            expect([value, scale, mode, decimal.output?.value]).toEqual([
              value,
              scale,
              mode,
              expected[i],
            ]);
            expect([...decimal.recorded.values()]).toStrictEqual([{ value }]);
            const number = OutputCombiner.combine(
              'n',
              { type: 'number', combine: 'highestPriority', rounding },
              [of(rule('a'), Number(value))],
              'throw',
            ).output?.value;
            expect(Object.is(number, Number(expected[i]))).toBe(true);
          }
        });
      }
    });

    it('rounds to 20 places and to 0', () => {
      const at20 = OutputCombiner.combine(
        'd',
        { type: 'decimal', combine: 'max', rounding: { scale: 20, mode: 'halfUp' } },
        [of(rule('a'), '0.123456789012345678905'), of(rule('b'), '0.1')],
        'throw',
      );
      expect(at20.output?.value).toBe('0.12345678901234567891');
      const at0 = OutputCombiner.combine(
        'd',
        { type: 'decimal', combine: 'min', rounding: { scale: 0, mode: 'ceiling' } },
        [of(rule('a'), '-7.9'), of(rule('b'), '3')],
        'throw',
      );
      expect(at0.output?.value).toBe('-7');
    });

    it("rounds each contribution before combining at 'contribution', recording unrounded", () => {
      const a = rule('a', 200);
      const b = rule('b', 100);
      const c = rule('c', 50);
      const contributions = [of(a, '1.005'), of(b, '1.005'), of(c, '0.5')];
      const perContribution = OutputCombiner.combine(
        'tax',
        {
          type: 'decimal',
          combine: 'sum',
          rounding: { scale: 2, mode: 'halfUp', at: 'contribution' },
        },
        contributions,
        'throw',
      );
      expect(perContribution.output?.value).toBe('2.52');
      expect(perContribution.recorded).toStrictEqual(
        new Map([
          [a, { value: '1.01', unrounded: '1.005' }],
          [b, { value: '1.01', unrounded: '1.005' }],
          [c, { value: '0.5' }],
        ]),
      );
      const perOutput = OutputCombiner.combine(
        'tax',
        { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'halfUp', at: 'output' } },
        contributions,
        'throw',
      );
      expect(perOutput.output?.value).toBe('2.51');
      expect(perOutput.recorded).toStrictEqual(
        new Map([
          [a, { value: '1.005' }],
          [b, { value: '1.005' }],
          [c, { value: '0.5' }],
        ]),
      );
    });

    it('gives 2.02 for 1.005 + 1.005 at 2 places halfUp per contribution, 2.01 per output', () => {
      const pair = [of(rule('a'), '1.005'), of(rule('b'), '1.005')];
      const at = (where: 'output' | 'contribution'): JsonValue | undefined =>
        OutputCombiner.combine(
          'tax',
          { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'halfUp', at: where } },
          pair,
          'throw',
        ).output?.value;
      expect(at('contribution')).toBe('2.02');
      expect(at('output')).toBe('2.01');
    });

    it('computes a rounded number in Decimal, then converts it to a number', () => {
      const a = rule('a', 200);
      const b = rule('b', 100);
      // In floating point, 1.005 is below 1.005 and Math.round(1.005 * 100) / 100 gives 1.
      expect(
        OutputCombiner.combine(
          'n',
          { type: 'number', combine: 'sum', rounding: { scale: 2, mode: 'halfUp' } },
          [of(a, 1.005)],
          'throw',
        ).output?.value,
      ).toBe(1.01);
      const perContribution = OutputCombiner.combine(
        'n',
        {
          type: 'number',
          combine: 'sum',
          rounding: { scale: 0, mode: 'floor', at: 'contribution' },
        },
        [of(a, 2.7), of(b, 3)],
        'throw',
      );
      expect(perContribution.output?.value).toBe(5);
      expect(perContribution.recorded).toStrictEqual(
        new Map([
          [a, { value: 2, unrounded: 2.7 }],
          [b, { value: 3 }],
        ]),
      );
    });

    it('agrees contributions equal once rounded under highestPriority', () => {
      const { output, skipped } = OutputCombiner.combine(
        'rate',
        {
          type: 'decimal',
          combine: 'highestPriority',
          rounding: { scale: 2, mode: 'halfUp', at: 'contribution' },
        },
        [of(rule('x', 500), '0.181'), of(rule('y', 500), '0.18')],
        'throw',
      );
      expect(skipped).toEqual([]);
      expect(output?.value).toBe('0.18');
      expect(output?.contributors).toEqual(['x', 'y']);
    });
  });

  describe('the span limit of 1000 digits on every decimal (R39)', () => {
    const over = `1${'0'.repeat(999)}.1`; // spans 1001 digits
    const at = `1${'0'.repeat(998)}.1`; // spans 1000 digits
    const declare = (
      combine: OutputDeclaration['combine'],
      rounding?: OutputRounding,
    ): OutputDeclaration =>
      rounding === undefined
        ? { type: 'decimal', combine }
        : { type: 'decimal', combine, rounding };
    const refusal = (run: () => unknown): DecimalPrecisionError => {
      try {
        run();
      } catch (e) {
        if (e instanceof DecimalPrecisionError) return e;
        throw e;
      }
      return expect.unreachable('should have thrown');
    };

    it('refuses a contribution beyond the limit under max, min and highestPriority', () => {
      for (const combine of ['max', 'min', 'highestPriority'] as const) {
        const e = refusal(() =>
          OutputCombiner.combine(
            'amount',
            declare(combine),
            [of(rule('a', 900), '1'), of(rule('b'), over)],
            'throw',
          ),
        );
        expect([e.code, e.output, e.limit]).toEqual(['DECIMAL_PRECISION', 'amount', 1000]);
      }
    });

    it('accepts a contribution of a span of exactly 1000 digits', () => {
      for (const combine of ['max', 'min', 'highestPriority', 'sum'] as const) {
        expect(
          OutputCombiner.combine('amount', declare(combine), [of(rule('a'), at)], 'throw').output
            ?.value,
        ).toBe(at);
      }
    });

    it('refuses a contribution beyond the limit even when rounding would shorten it', () => {
      for (const where of ['output', 'contribution'] as const) {
        refusal(() =>
          OutputCombiner.combine(
            'amount',
            declare('max', { scale: 0, mode: 'down', at: where }),
            [of(rule('a'), over)],
            'throw',
          ),
        );
      }
    });

    const sum = (values: readonly string[]): JsonValue | undefined =>
      OutputCombiner.combine(
        'amount',
        declare('sum'),
        values.map((v, i) => of(rule(`r${String(i).padStart(5, '0')}`), v)),
        'first',
      ).output?.value;

    it('limits the positional span, trailing integer zeros and leading fraction zeros included', () => {
      const span1000 = `1${'0'.repeat(999)}`;
      expect(sum([span1000, '1'])).toBe(`1${'0'.repeat(998)}1`);
      expect(sum([span1000, `-${span1000}`, '1'])).toBe('1');
      expect(() => sum([`${span1000}0`])).toThrow(DecimalPrecisionError);
      expect(() => sum([`0.${'0'.repeat(999)}1`])).toThrow(DecimalPrecisionError);
      expect(() => sum([span1000, '0.1'])).toThrow(DecimalPrecisionError);
    });

    it('refuses a value of a million zeros when it is read, without computing', () => {
      const huge = `1${'0'.repeat(1_000_000)}`;
      for (const values of [
        [huge, '1'],
        [huge, `-${huge}`, '1'],
        [`0.${'0'.repeat(1_000_000)}1`],
      ]) {
        expect(() => sum(values)).toThrow(DecimalPrecisionError);
      }
    });

    it('sums 10 000 contributions of span 1000', () => {
      const span1000 = `9.${'9'.repeat(998)}`;
      const values = Array.from({ length: 10_000 }, (_, i) =>
        i % 2 === 0 ? span1000 : `-${span1000}`,
      );
      expect(sum(values)).toBe('0');
    });

    it('does not limit number outputs', () => {
      expect(
        OutputCombiner.combine('n', NUMBER('max'), [of(rule('a'), 1e300)], 'throw').output?.value,
      ).toBe(1e300);
    });
  });

  describe('impose (a short-circuit value, R38)', () => {
    const x = rule('X', 9000);

    it('takes a decimal string or a safe integer in canonical form', () => {
      expect(
        OutputCombiner.impose('amount', { type: 'decimal', combine: 'sum' }, x, '0012.50'),
      ).toStrictEqual({
        output: {
          name: 'amount',
          type: 'decimal',
          combine: 'sum',
          value: '12.5',
          contributors: ['X'],
        },
        recorded: { value: '12.5' },
      });
      expect(
        OutputCombiner.impose('amount', { type: 'decimal', combine: 'max' }, x, 12).output.value,
      ).toBe('12');
    });

    it("rounds it at 'output' without recording unrounded", () => {
      for (const rounding of [
        { scale: 2, mode: 'halfUp' },
        { scale: 2, mode: 'halfUp', at: 'output' },
      ] as const) {
        expect(
          OutputCombiner.impose(
            'amount',
            { type: 'decimal', combine: 'sum', rounding },
            x,
            '1.005',
          ),
        ).toStrictEqual({
          output: {
            name: 'amount',
            type: 'decimal',
            combine: 'sum',
            value: '1.01',
            contributors: ['X'],
          },
          recorded: { value: '1.005' },
        });
      }
    });

    it("rounds it as the only contribution at 'contribution', recording unrounded", () => {
      const imposed = OutputCombiner.impose(
        'amount',
        {
          type: 'decimal',
          combine: 'sum',
          rounding: { scale: 2, mode: 'halfUp', at: 'contribution' },
        },
        x,
        '1.005',
      );
      expect(imposed.output.value).toBe('1.01');
      expect(imposed.recorded).toStrictEqual({ value: '1.01', unrounded: '1.005' });
      const unchanged = OutputCombiner.impose(
        'amount',
        {
          type: 'decimal',
          combine: 'sum',
          rounding: { scale: 2, mode: 'halfUp', at: 'contribution' },
        },
        x,
        '1.5',
      );
      expect(unchanged.recorded).toStrictEqual({ value: '1.5' });
    });

    it('rounds a number output the same way', () => {
      expect(
        OutputCombiner.impose(
          'n',
          { type: 'number', combine: 'sum', rounding: { scale: 0, mode: 'floor' } },
          x,
          2.7,
        ),
      ).toStrictEqual({
        output: { name: 'n', type: 'number', combine: 'sum', value: 2, contributors: ['X'] },
        recorded: { value: 2.7 },
      });
      expect(
        OutputCombiner.impose(
          'n',
          {
            type: 'number',
            combine: 'sum',
            rounding: { scale: 0, mode: 'floor', at: 'contribution' },
          },
          x,
          2.7,
        ).recorded,
      ).toStrictEqual({ value: 2, unrounded: 2.7 });
    });

    it('keeps other types as they are', () => {
      expect(OutputCombiner.impose('risk', RISK, x, 'high').output.value).toBe('high');
    });

    it('refuses a decimal beyond the limit', () => {
      try {
        OutputCombiner.impose(
          'amount',
          { type: 'decimal', combine: 'highestPriority' },
          x,
          `1${'0'.repeat(999)}.1`,
        );
        expect.unreachable('should have thrown');
      } catch (e) {
        if (!(e instanceof DecimalPrecisionError)) throw e;
        expect([e.output, e.limit]).toEqual(['amount', 1000]);
      }
    });

    it('throws on a value the declaration refuses (the exception processor excluded it)', () => {
      expect(() =>
        OutputCombiner.impose('amount', { type: 'decimal', combine: 'sum' }, x, 0.1),
      ).toThrow(
        'short-circuit of X@1 on output amount: value 0.1 does not match type decimal: expected a decimal string (an optional "-", digits, an optional "." and digits, no exponent) or a safe integer',
      );
    });
  });
});
