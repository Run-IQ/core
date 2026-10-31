import { describe, it, expect } from 'vitest';
import type { JsonValue, OutputDeclaration } from '@run-iq/spec';
import { OutputCombiner } from '../../src/engine/OutputCombiner.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { OutputNotFiniteError } from '../../src/errors/OutputNotFiniteError.js';
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
      const unknown = JSON.parse('{"type":"number","combine":"avg"}') as OutputDeclaration;
      expect(() => OutputCombiner.combine('o', unknown, [of(rule('a'), 1)], 'throw')).toThrow(
        'Unknown combine strategy "avg" for output o',
      );
    });
  });
});
