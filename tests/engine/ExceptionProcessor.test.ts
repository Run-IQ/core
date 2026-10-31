import { describe, it, expect } from 'vitest';
import { EXCEPTION_MODEL } from '@run-iq/spec';
import type { JsonValue, OutputDeclaration, ProofException, RuleException } from '@run-iq/spec';
import { ExceptionProcessor } from '../../src/engine/ExceptionProcessor.js';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import type { CalculationModel, ValidationResult } from '../../src/types/model.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, StubModel } from '../helpers.js';

/** Declares an enum output; never calculated here, so it keeps the default number value type. */
class RiskModel implements CalculationModel {
  readonly name = 'Risk';
  readonly version = '1.0.0';
  readonly output: OutputDeclaration = {
    type: 'enum',
    combine: 'highestPriority',
    values: ['low', 'high'],
  };
  validateParams(): ValidationResult {
    return { valid: true };
  }
  calculate(): number {
    return 0;
  }
}

class RateModel implements CalculationModel {
  readonly name = 'Rate';
  readonly version = '1.0.0';
  validateParams(params: unknown): ValidationResult {
    const rate =
      typeof params === 'object' && params !== null && 'rate' in params ? params.rate : undefined;
    return typeof rate === 'number'
      ? { valid: true }
      : { valid: false, errors: ['rate must be a number', 'see the model docs'] };
  }
  calculate(): number {
    return 1;
  }
}

function makeRegistry(): ModelRegistry {
  const registry = new ModelRegistry();
  registry.register(new StubModel('M'));
  registry.register(new RiskModel());
  registry.register(new RateModel());
  return registry;
}

function carrier(
  id: string,
  priority: number,
  exceptions: RuleException[],
  overrides: Partial<Rule> = {},
): Rule {
  return makeRule({ id, model: EXCEPTION_MODEL, priority, exceptions, ...overrides });
}

const inhibit = (ids: string[]): RuleException => ({ kind: 'inhibit', targets: { ids } });
const substitute = (ids: string[], params: { [k: string]: JsonValue }): RuleException => ({
  kind: 'substitute',
  targets: { ids },
  params,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value) as unknown[]) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

describe('ExceptionProcessor', () => {
  const processor = new ExceptionProcessor(makeRegistry());

  describe('inhibit', () => {
    it('skips the target with INHIBITED naming the source rule', () => {
      const x = carrier('X', 9000, [inhibit(['B'])]);
      const b = makeRule({ id: 'B', model: 'M' });
      const result = processor.apply([b, x], 'throw');

      expect(result.rules).toEqual([]);
      expect(result.skipped).toEqual([
        { rule: b, reason: 'INHIBITED', detail: 'inhibited by X@1' },
      ]);
      const expected: ProofException[] = [
        { ruleId: 'X', version: 1, kind: 'inhibit', affected: ['B'] },
      ];
      expect(result.applied).toEqual(expected);
      expect(result.shortCircuits.size).toBe(0);
    });

    it('lets an inhibited rule fire nothing: exceptions of exceptions', () => {
      const c = carrier('C', 9000, [inhibit(['A'])]);
      const a = carrier('A', 5000, [inhibit(['B'])]);
      const b = makeRule({ id: 'B', model: 'M' });
      const result = processor.apply([a, b, c], 'throw');

      expect(result.rules).toEqual([b]);
      expect(result.skipped).toEqual([
        { rule: a, reason: 'INHIBITED', detail: 'inhibited by C@1' },
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'C', version: 1, kind: 'inhibit', affected: ['A'] },
      ]);
    });

    it('resolves a mutual inhibition by priority', () => {
      const low = makeRule({ id: 'a', model: 'M', priority: 100, exceptions: [inhibit(['b'])] });
      const high = makeRule({ id: 'b', model: 'M', priority: 200, exceptions: [inhibit(['a'])] });
      const result = processor.apply([low, high], 'throw');
      expect(result.rules).toEqual([high]);
      expect(result.skipped).toEqual([
        { rule: low, reason: 'INHIBITED', detail: 'inhibited by b@1' },
      ]);
    });

    it('resolves a mutual inhibition at equal priority by the lowest id, whatever the order', () => {
      const a = makeRule({ id: 'a', model: 'M', priority: 100, exceptions: [inhibit(['b'])] });
      const b = makeRule({ id: 'b', model: 'M', priority: 100, exceptions: [inhibit(['a'])] });
      const forward = processor.apply([a, b], 'throw');
      expect(forward.rules).toEqual([a]);
      expect(forward.skipped).toEqual([
        { rule: b, reason: 'INHIBITED', detail: 'inhibited by a@1' },
      ]);
      expect(forward.applied).toEqual([
        { ruleId: 'a', version: 1, kind: 'inhibit', affected: ['b'] },
      ]);
      expect(processor.apply([b, a], 'throw')).toEqual(forward);
    });

    it('selects targets by tags, and a rule never targets itself', () => {
      const k = makeRule({
        id: 'K',
        model: 'M',
        priority: 500,
        tags: ['promo'],
        exceptions: [{ kind: 'inhibit', targets: { tags: ['promo'] } }],
      });
      const p = makeRule({ id: 'P', model: 'M', tags: ['promo'] });
      const q = makeRule({ id: 'Q', model: 'M', tags: ['other'] });
      const result = processor.apply([q, p, k], 'throw');
      expect(result.rules).toEqual([k, q]);
      expect(result.skipped).toEqual([
        { rule: p, reason: 'INHIBITED', detail: 'inhibited by K@1' },
      ]);
    });

    it('never matches an exception-only rule by output: it has none', () => {
      const x = carrier('X', 9000, [{ kind: 'inhibit', targets: { outputs: ['value'] } }]);
      const y = carrier('Y', 100, [inhibit(['B'])]);
      const b = makeRule({ id: 'B', model: 'M' });
      const result = processor.apply([x, y, b], 'throw');
      expect(result.rules).toEqual([]);
      expect(result.skipped).toEqual([
        { rule: b, reason: 'INHIBITED', detail: 'inhibited by X@1' },
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'X', version: 1, kind: 'inhibit', affected: ['B'] },
      ]);
    });

    it('lists affected ids sorted', () => {
      const x = carrier('X', 9000, [{ kind: 'inhibit', targets: { models: ['M'] } }]);
      const rules = [
        makeRule({ id: 'z', model: 'M' }),
        makeRule({ id: 'a', model: 'M', priority: 50 }),
        makeRule({ id: 'm', model: 'M', priority: 300 }),
      ];
      const result = processor.apply([...rules, x], 'throw');
      expect(result.applied).toEqual([
        { ruleId: 'X', version: 1, kind: 'inhibit', affected: ['a', 'm', 'z'] },
      ]);
    });
  });

  describe('carrier that also computes', () => {
    it('keeps a carrier whose model is not EXCEPTION_MODEL in rules', () => {
      const k = makeRule({ id: 'K', model: 'M', priority: 500, exceptions: [inhibit(['B'])] });
      const b = makeRule({ id: 'B', model: 'M' });
      const result = processor.apply([b, k], 'throw');
      expect(result.rules).toEqual([k]);
      expect(result.skipped).toEqual([
        { rule: b, reason: 'INHIBITED', detail: 'inhibited by K@1' },
      ]);
    });

    it('removes an EXCEPTION_MODEL rule from rules without skipping it', () => {
      const x = carrier('X', 9000, [inhibit(['nobody'])]);
      const b = makeRule({ id: 'B', model: 'M' });
      const result = processor.apply([x, b], 'throw');
      expect(result.rules).toEqual([b]);
      expect(result.skipped).toEqual([]);
      expect(result.applied).toEqual([]);
    });

    it('returns rules without exceptions untouched', () => {
      const a = makeRule({ id: 'a', model: 'M', priority: 1 });
      const b = makeRule({ id: 'b', model: 'M', priority: 2 });
      const result = processor.apply([a, b], 'throw');
      expect(result.rules).toHaveLength(2);
      expect(result.rules[0]).toBe(b);
      expect(result.rules[1]).toBe(a);
      expect(result.skipped).toEqual([]);
      expect(result.applied).toEqual([]);
      expect(result.shortCircuits.size).toBe(0);
    });
  });

  describe('substitute', () => {
    it('lets the highest priority win on a conflicting key', () => {
      const t = makeRule({ id: 'T', model: 'Rate', params: { rate: 0.5, base: 'x' } });
      const high = carrier('S-high', 9000, [substitute(['T'], { rate: 0.1 })]);
      const low = carrier('S-low', 5000, [substitute(['T'], { rate: 0.02 })]);
      const result = processor.apply([low, t, high], 'throw');

      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]!.params).toEqual({ rate: 0.1, base: 'x' });
      expect(result.skipped).toEqual([]);
      expect(result.applied).toEqual([
        { ruleId: 'S-high', version: 1, kind: 'substitute', affected: ['T'] },
        { ruleId: 'S-low', version: 1, kind: 'substitute', affected: ['T'] },
      ]);
    });

    it('merges deeply, replaces arrays and leaves the frozen original untouched', () => {
      const t = deepFreeze(
        makeRule({
          id: 'T',
          model: 'M',
          params: { brackets: [1, 2, 3], opts: { a: 1, b: { c: 2 } } },
        }),
      );
      const s = deepFreeze(
        carrier('S', 9000, [substitute(['T'], { brackets: [9], opts: { b: { d: 3 } } })]),
      );
      const result = processor.apply([t, s], 'throw');

      const substituted = result.rules[0]!;
      expect(substituted).not.toBe(t);
      expect(substituted.params).toEqual({ brackets: [9], opts: { a: 1, b: { c: 2, d: 3 } } });
      expect({ ...substituted, params: t.params }).toEqual(t);
      expect(t.params).toEqual({ brackets: [1, 2, 3], opts: { a: 1, b: { c: 2 } } });
    });

    it('skips the target with INVALID_PARAMS when the model refuses the substituted params', () => {
      const t = makeRule({ id: 'T', model: 'Rate', params: { rate: 0.5 } });
      const s = carrier('S', 9000, [substitute(['T'], { rate: 'high' })]);
      const result = processor.apply([t, s], 'throw');

      expect(result.rules).toEqual([]);
      expect(result.skipped).toEqual([
        {
          rule: t,
          reason: 'INVALID_PARAMS',
          detail: 'after substitution by S@1: rate must be a number; see the model docs',
        },
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'S', version: 1, kind: 'substitute', affected: ['T'] },
      ]);
    });

    it('names every substituting rule, in application order, when the result is refused', () => {
      const t = makeRule({ id: 'T', model: 'Rate', params: { rate: 0.5 } });
      const a = carrier('A', 9000, [substitute(['T'], { extra: 1 })]);
      const b = carrier('B', 5000, [substitute(['T'], { rate: 'x' })]);
      const result = processor.apply([t, a, b], 'throw');
      expect(result.skipped).toEqual([
        {
          rule: t,
          reason: 'INVALID_PARAMS',
          detail: 'after substitution by B@1, A@1: rate must be a number; see the model docs',
        },
      ]);
    });

    it('does not substitute an inhibited rule', () => {
      const t = makeRule({ id: 'T', model: 'Rate', params: { rate: 0.5 } });
      const s = carrier('S', 9000, [substitute(['T'], { rate: 0.1 })]);
      const i = carrier('I', 100, [inhibit(['T'])]);
      const result = processor.apply([t, s, i], 'throw');
      expect(result.rules).toEqual([]);
      expect(result.skipped).toEqual([
        { rule: t, reason: 'INHIBITED', detail: 'inhibited by I@1' },
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'I', version: 1, kind: 'inhibit', affected: ['T'] },
      ]);
    });

    it('applies non-conflicting substitutions of equal priority together', () => {
      const t = makeRule({ id: 'T', model: 'Rate', params: { rate: 0.5 } });
      const a = carrier('A', 5000, [substitute(['T'], { rate: 0.2, x: { k: 1 } })]);
      const b = carrier('B', 5000, [substitute(['T'], { rate: 0.2, x: { j: 2 } })]);
      const result = processor.apply([b, t, a], 'throw');
      expect(result.rules[0]!.params).toEqual({ rate: 0.2, x: { k: 1, j: 2 } });
      expect(result.skipped).toEqual([]);
    });

    it('throws RuleConflictError on conflicting keys at equal priority in throw mode', () => {
      const t = makeRule({ id: 'T', model: 'Rate', params: { rate: 0.5 } });
      const a = carrier('A', 5000, [substitute(['T'], { rate: 0.1 })]);
      const b = carrier('B', 5000, [substitute(['T'], { rate: 0.2 })]);
      for (const order of permutations([t, a, b])) {
        try {
          processor.apply(order, 'throw');
          expect.unreachable('should have thrown');
        } catch (e) {
          if (!(e instanceof RuleConflictError)) throw e;
          expect(e.ruleIds).toEqual(['A', 'B']);
          expect(e.priority).toBe(5000);
        }
      }
    });

    it("keeps the lowest id on conflicting keys at equal priority in 'first' mode", () => {
      const t = makeRule({ id: 'T', model: 'Rate', params: { rate: 0.5 } });
      const a = carrier('A', 5000, [substitute(['T'], { rate: 0.1 })]);
      const b = carrier('B', 5000, [substitute(['T'], { rate: 0.2 })]);
      const expected = processor.apply([t, a, b], 'first');
      expect(expected.rules[0]!.params).toEqual({ rate: 0.1 });
      expect(expected.skipped).toEqual([
        {
          rule: b,
          reason: 'RULE_CONFLICT',
          detail: 'tied with A@1 at priority 5000; the lowest id@version wins',
        },
      ]);
      expect(expected.applied).toEqual([
        { ruleId: 'A', version: 1, kind: 'substitute', affected: ['T'] },
      ]);
      for (const order of permutations([t, a, b])) {
        expect(processor.apply(order, 'first')).toEqual(expected);
      }
    });
  });

  describe('shortCircuit', () => {
    const risk = (id: string, priority = 100): Rule =>
      makeRule({ id, model: 'Risk', output: 'riskLevel', priority });

    it('excludes only the rules of the short-circuited output', () => {
      const sc = carrier('SC', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'high', reason: 'blacklisted' },
      ]);
      const r1 = risk('R1');
      const v1 = makeRule({ id: 'V1', model: 'M' });
      const result = processor.apply([v1, r1, sc], 'throw');

      expect(result.rules).toEqual([v1]);
      expect(result.skipped).toEqual([
        {
          rule: r1,
          reason: 'SHORT_CIRCUITED',
          detail: 'output riskLevel short-circuited by SC@1',
        },
      ]);
      expect([...result.shortCircuits.entries()]).toEqual([
        ['riskLevel', { rule: sc, value: 'high', reason: 'blacklisted' }],
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'SC', version: 1, kind: 'shortCircuit', affected: ['R1'] },
      ]);
    });

    it('omits reason when the exception has none, and records an empty affected list', () => {
      const sc = carrier('SC', 9000, [{ kind: 'shortCircuit', output: 'value', value: 0 }]);
      const result = processor.apply([sc], 'throw');
      expect(result.shortCircuits.get('value')).toEqual({ rule: sc, value: 0 });
      expect(Object.hasOwn(result.shortCircuits.get('value')!, 'reason')).toBe(false);
      expect(result.applied).toEqual([
        { ruleId: 'SC', version: 1, kind: 'shortCircuit', affected: [] },
      ]);
    });

    it('keeps a computing carrier of the short-circuited output and excludes the others', () => {
      const k = makeRule({
        id: 'K',
        model: 'M',
        priority: 500,
        exceptions: [{ kind: 'shortCircuit', output: 'value', value: 7 }],
      });
      const v = makeRule({ id: 'V', model: 'M' });
      const result = processor.apply([v, k], 'throw');
      expect(result.rules).toEqual([k]);
      expect(result.skipped).toEqual([
        { rule: v, reason: 'SHORT_CIRCUITED', detail: 'output value short-circuited by K@1' },
      ]);
    });

    it('lets the highest priority short-circuit win an output without conflict', () => {
      const high = carrier('SC-high', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'high' },
      ]);
      const low = carrier('SC-low', 100, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'low' },
      ]);
      const result = processor.apply([low, high], 'throw');
      expect(result.shortCircuits.get('riskLevel')).toEqual({ rule: high, value: 'high' });
      expect(result.skipped).toEqual([]);
      expect(result.applied).toEqual([
        { ruleId: 'SC-high', version: 1, kind: 'shortCircuit', affected: [] },
      ]);
    });

    it('does not short-circuit from an inhibited carrier', () => {
      const i = carrier('I', 9900, [inhibit(['SC'])]);
      const sc = carrier('SC', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'high' },
      ]);
      const r1 = risk('R1');
      const result = processor.apply([r1, sc, i], 'throw');
      expect(result.rules).toEqual([r1]);
      expect(result.shortCircuits.size).toBe(0);
      expect(result.skipped).toEqual([
        { rule: sc, reason: 'INHIBITED', detail: 'inhibited by I@1' },
      ]);
    });

    it('reports SHORT_CIRCUITED rather than INHIBITED for a rule of a short-circuited output', () => {
      const sc = carrier('SC', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'high' },
      ]);
      const i = carrier('I', 5000, [inhibit(['R1'])]);
      const r1 = risk('R1');
      const result = processor.apply([r1, i, sc], 'throw');
      expect(result.skipped).toEqual([
        { rule: r1, reason: 'SHORT_CIRCUITED', detail: 'output riskLevel short-circuited by SC@1' },
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'SC', version: 1, kind: 'shortCircuit', affected: ['R1'] },
        { ruleId: 'I', version: 1, kind: 'inhibit', affected: ['R1'] },
      ]);
    });

    it('throws RuleConflictError on two short-circuits of one output at equal priority', () => {
      const a = carrier('sc-a', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'high' },
      ]);
      const b = carrier('sc-b', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'low' },
      ]);
      for (const order of permutations([a, b, risk('R1')])) {
        try {
          processor.apply(order, 'throw');
          expect.unreachable('should have thrown');
        } catch (e) {
          if (!(e instanceof RuleConflictError)) throw e;
          expect(e.ruleIds).toEqual(['sc-a', 'sc-b']);
          expect(e.priority).toBe(9000);
        }
      }
    });

    it("keeps the lowest id on two short-circuits of one output at equal priority in 'first' mode", () => {
      const a = carrier('sc-a', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'high' },
      ]);
      const b = carrier('sc-b', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'low' },
        inhibit(['V']),
      ]);
      const r1 = risk('R1');
      const v = makeRule({ id: 'V', model: 'M' });
      const expected = processor.apply([b, r1, a, v], 'first');
      expect(expected.rules).toEqual([v]);
      expect(expected.shortCircuits.get('riskLevel')).toEqual({ rule: a, value: 'high' });
      expect(expected.skipped).toEqual([
        {
          rule: b,
          reason: 'RULE_CONFLICT',
          detail: 'tied with sc-a@1 at priority 9000; the lowest id@version wins',
        },
        {
          rule: r1,
          reason: 'SHORT_CIRCUITED',
          detail: 'output riskLevel short-circuited by sc-a@1',
        },
      ]);
      expect(expected.applied).toEqual([
        { ruleId: 'sc-a', version: 1, kind: 'shortCircuit', affected: ['R1'] },
      ]);
      for (const order of permutations([a, b, r1, v])) {
        expect(processor.apply(order, 'first')).toEqual(expected);
      }
    });

    it('skips the carrier with OUTPUT_MISMATCH when the value does not match the declaration of the output rules', () => {
      const sc = carrier('SC', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'medium' },
        inhibit(['V']),
      ]);
      const r1 = risk('R1');
      const v = makeRule({ id: 'V', model: 'M' });
      const result = processor.apply([sc, r1, v], 'throw');
      expect(result.rules).toEqual([r1, v]);
      expect(result.shortCircuits.size).toBe(0);
      expect(result.skipped).toEqual([
        {
          rule: sc,
          reason: 'OUTPUT_MISMATCH',
          detail:
            'shortCircuit of SC@1 on output riskLevel: value "medium" does not match type enum (low, high)',
        },
      ]);
      expect(result.applied).toEqual([]);
    });

    it('checks a short-circuit of value without rules against the default declaration', () => {
      const bad = carrier('SC', 9000, [{ kind: 'shortCircuit', output: 'value', value: 'x' }]);
      expect(processor.apply([bad], 'throw').skipped).toEqual([
        {
          rule: bad,
          reason: 'OUTPUT_MISMATCH',
          detail: 'shortCircuit of SC@1 on output value: value "x" does not match type number',
        },
      ]);
      const good = carrier('SC', 9000, [{ kind: 'shortCircuit', output: 'value', value: 12 }]);
      expect(processor.apply([good], 'throw').skipped).toEqual([]);
    });

    it('accepts any value on an output no rule declares', () => {
      const sc = carrier('SC', 9000, [
        { kind: 'shortCircuit', output: 'flags', value: { any: ['thing'] } },
      ]);
      const result = processor.apply([sc], 'throw');
      expect(result.skipped).toEqual([]);
      expect(result.shortCircuits.get('flags')).toEqual({ rule: sc, value: { any: ['thing'] } });
    });
  });

  describe('determinism', () => {
    it('returns the same result for every input order', () => {
      const fixture = [
        carrier('C', 9000, [inhibit(['A'])]),
        carrier('A', 5000, [inhibit(['B'])]),
        makeRule({ id: 'B', model: 'Rate', params: { rate: 0.5 } }),
        carrier('S2', 5000, [substitute(['B'], { rate: 0.3, more: [1] })]),
        carrier('S1', 6000, [substitute(['B'], { rate: 0.2 })]),
        carrier('SC', 4000, [{ kind: 'shortCircuit', output: 'riskLevel', value: 'high' }]),
        makeRule({ id: 'R2', model: 'Risk', output: 'riskLevel', priority: 300 }),
        makeRule({ id: 'R1', model: 'Risk', output: 'riskLevel', priority: 300 }),
      ];
      const expected = processor.apply(fixture, 'first');
      expect(expected.rules.map((r) => r.id)).toEqual(['B']);
      expect(expected.rules[0]!.params).toEqual({ rate: 0.2, more: [1] });
      expect(expected.skipped.map((s) => `${s.rule.id}:${s.reason}`)).toEqual([
        'A:INHIBITED',
        'R1:SHORT_CIRCUITED',
        'R2:SHORT_CIRCUITED',
      ]);
      expect(expected.applied).toEqual([
        { ruleId: 'C', version: 1, kind: 'inhibit', affected: ['A'] },
        { ruleId: 'S1', version: 1, kind: 'substitute', affected: ['B'] },
        { ruleId: 'S2', version: 1, kind: 'substitute', affected: ['B'] },
        { ruleId: 'SC', version: 1, kind: 'shortCircuit', affected: ['R1', 'R2'] },
      ]);
      for (const order of permutations(fixture)) {
        const result = processor.apply(order, 'first');
        expect(result).toEqual(expected);
        expect([...result.shortCircuits.keys()]).toEqual([...expected.shortCircuits.keys()]);
      }
    });
  });
});
