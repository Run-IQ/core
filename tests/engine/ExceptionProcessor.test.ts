import { describe, it, expect } from 'vitest';
import { DEFAULT_OUTPUT_DECLARATION, EXCEPTION_MODEL } from '@run-iq/spec';
import type { JsonValue, OutputDeclaration, ProofException, RuleException } from '@run-iq/spec';
import { ExceptionProcessor } from '../../src/engine/ExceptionProcessor.js';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { RuleConflictError } from '../../src/errors/RuleConflictError.js';
import { ExceptionPrecedenceError } from '../../src/errors/ExceptionPrecedenceError.js';
import type { ExceptionResult } from '../../src/engine/ExceptionProcessor.js';
import type { CalculationModel, ValidationResult } from '../../src/types/model.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, StubModel, ValueModel } from '../helpers.js';

const RISK: OutputDeclaration = {
  type: 'enum',
  combine: 'highestPriority',
  values: ['low', 'high'],
};

/** Declares an enum output; never calculated here, so it keeps the default number value type. */
class RiskModel implements CalculationModel {
  readonly name = 'Risk';
  readonly version = '1.0.0';
  readonly output: OutputDeclaration = RISK;
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

const key = (rule: Rule): string => `${rule.id}@${rule.version}`;

/**
 * Every input rule is passed on, or skipped, exactly once; or it is an EXCEPTION_MODEL carrier
 * with at least one applied record. No rule both is INHIBITED and has an applied record.
 */
function expectInvariants(input: readonly Rule[], result: ExceptionResult): void {
  expect(result.rules.filter((rule) => rule.model === EXCEPTION_MODEL)).toEqual([]);
  const passed = result.rules.map(key);
  const skipped = result.skipped.map((s) => key(s.rule));
  const recorded = result.applied.map((a) => `${a.ruleId}@${a.version}`);
  for (const rule of input) {
    const k = key(rule);
    const places = passed.filter((x) => x === k).length + skipped.filter((x) => x === k).length;
    if (rule.model === EXCEPTION_MODEL && places === 0) {
      expect(recorded, `${k} vanished`).toContain(k);
    } else {
      expect(places, `${k} placed ${places} times`).toBe(1);
    }
  }
  const inhibited = result.skipped.filter((s) => s.reason === 'INHIBITED').map((s) => key(s.rule));
  for (const k of inhibited) expect(recorded, `${k} inhibited yet fired`).not.toContain(k);
}

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
        { ruleId: 'Y', version: 1, kind: 'inhibit', affected: [] },
      ]);
    });

    it('records an inhibit whose targets were all already excluded, with no affected rule', () => {
      const x = carrier('X', 9000, [inhibit(['B'])]);
      const y = carrier('Y', 100, [inhibit(['B'])]);
      const b = makeRule({ id: 'B', model: 'M' });
      const result = processor.apply([b, y, x], 'throw');
      expect(result.skipped).toEqual([
        { rule: b, reason: 'INHIBITED', detail: 'inhibited by X@1' },
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'X', version: 1, kind: 'inhibit', affected: ['B'] },
        { ruleId: 'Y', version: 1, kind: 'inhibit', affected: [] },
      ]);
      expectInvariants([b, y, x], result);
    });

    it('lets a low priority rule inhibit a higher one that carries no exception', () => {
      const h = makeRule({ id: 'H', model: 'M', priority: 9000 });
      const l = carrier('L', 10, [inhibit(['H'])]);
      const result = processor.apply([h, l], 'throw');
      expect(result.rules).toEqual([]);
      expect(result.skipped).toEqual([
        { rule: h, reason: 'INHIBITED', detail: 'inhibited by L@1' },
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'L', version: 1, kind: 'inhibit', affected: ['H'] },
      ]);
    });

    describe('precedence: inhibiting a carrier that already fired', () => {
      const sc = carrier('SC', 9000, [{ kind: 'shortCircuit', output: 'value', value: 5 }]);
      const i = carrier('I', 100, [inhibit(['SC'])]);
      const v = makeRule({ id: 'V', model: 'M' });
      const d1 = makeRule({ id: 'd1', model: 'M', priority: 3, exceptions: [inhibit(['d2'])] });
      const d2 = makeRule({ id: 'd2', model: 'M', priority: 2 });
      const d3 = makeRule({ id: 'd3', model: 'M', priority: 1, exceptions: [inhibit(['d1'])] });

      it('throws ExceptionPrecedenceError in throw mode, whatever the order', () => {
        for (const order of permutations([sc, i, v])) {
          try {
            processor.apply(order, 'throw');
            expect.unreachable('should have thrown');
          } catch (e) {
            if (!(e instanceof ExceptionPrecedenceError)) throw e;
            expect(e.code).toBe('EXCEPTION_PRECEDENCE');
            expect(e.inhibitorId).toBe('I');
            expect(e.targetId).toBe('SC');
            expect(e.message).toBe(
              'Exception precedence conflict: I@1 inhibits SC@1, which takes precedence and already fired',
            );
          }
        }
      });

      it("skips the newcomer with RULE_CONFLICT in 'first' mode, and it fires nothing", () => {
        const expected = processor.apply([sc, i, v], 'first');
        expect(expected.rules).toEqual([]);
        expect(expected.skipped).toEqual([
          {
            rule: i,
            reason: 'RULE_CONFLICT',
            detail: 'inhibits SC@1, which takes precedence and already fired',
          },
          { rule: v, reason: 'SHORT_CIRCUITED', detail: 'output value short-circuited by SC@1' },
        ]);
        expect(expected.applied).toEqual([
          { ruleId: 'SC', version: 1, kind: 'shortCircuit', affected: ['V'] },
        ]);
        for (const order of permutations([sc, i, v])) {
          const result = processor.apply(order, 'first');
          expect(result).toEqual(expected);
          expectInvariants(order, result);
        }
      });

      it("refuses an upward inhibition chain in 'first' mode", () => {
        const expected = processor.apply([d1, d2, d3], 'first');
        expect(expected.rules).toEqual([d1]);
        expect(expected.skipped).toEqual([
          { rule: d2, reason: 'INHIBITED', detail: 'inhibited by d1@1' },
          {
            rule: d3,
            reason: 'RULE_CONFLICT',
            detail: 'inhibits d1@1, which takes precedence and already fired',
          },
        ]);
        for (const order of permutations([d1, d2, d3])) {
          const result = processor.apply(order, 'first');
          expect(result).toEqual(expected);
          expectInvariants(order, result);
          expect(() => processor.apply(order, 'throw')).toThrow(ExceptionPrecedenceError);
        }
      });
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
      expect(result.applied).toEqual([{ ruleId: 'X', version: 1, kind: 'inhibit', affected: [] }]);
      expectInvariants([x, b], result);
    });

    it('still fires the exceptions of a carrier that is SHORT_CIRCUITED or has INVALID_PARAMS', () => {
      const sc = carrier('SC', 9000, [{ kind: 'shortCircuit', output: 'value', value: 5 }]);
      const k = makeRule({ id: 'K', model: 'M', priority: 10, exceptions: [inhibit(['W'])] });
      const w = makeRule({ id: 'W', model: 'M', output: 'other' });
      const t = makeRule({
        id: 'T',
        model: 'Rate',
        params: { rate: 0.5 },
        output: 'rate',
        priority: 10,
        exceptions: [inhibit(['W2'])],
      });
      const s = carrier('S', 8000, [substitute(['T'], { rate: 'bad' })]);
      const w2 = makeRule({ id: 'W2', model: 'M', output: 'other' });
      const input = [sc, k, w, t, s, w2];
      const result = processor.apply(input, 'throw');
      expect(result.rules).toEqual([]);
      expect(result.skipped.map((x) => [x.rule.id, x.reason, x.detail])).toEqual([
        ['W', 'INHIBITED', 'inhibited by K@1'],
        ['W2', 'INHIBITED', 'inhibited by T@1'],
        ['K', 'SHORT_CIRCUITED', 'output value short-circuited by SC@1'],
        [
          'T',
          'INVALID_PARAMS',
          'after substitution by S@1: rate must be a number; see the model docs',
        ],
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'SC', version: 1, kind: 'shortCircuit', affected: ['K'] },
        { ruleId: 'S', version: 1, kind: 'substitute', affected: ['T'] },
        { ruleId: 'K', version: 1, kind: 'inhibit', affected: ['W'] },
        { ruleId: 'T', version: 1, kind: 'inhibit', affected: ['W2'] },
      ]);
      expectInvariants(input, result);
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
        { ruleId: 'S', version: 1, kind: 'substitute', affected: [] },
        { ruleId: 'I', version: 1, kind: 'inhibit', affected: ['T'] },
      ]);
    });

    it('does not see a conflict on a target already excluded when the carriers fire', () => {
      const t = makeRule({ id: 'T', model: 'M' });
      const a = carrier('A', 500, [substitute(['T'], { r: 1 })]);
      const b = carrier('B', 500, [substitute(['T'], { r: 2 })]);
      const x = carrier('X', 9000, [inhibit(['T'])]);
      for (const order of permutations([t, a, b, x])) {
        const result = processor.apply(order, 'throw');
        expect(result.rules).toEqual([]);
        expect(result.skipped).toEqual([
          { rule: t, reason: 'INHIBITED', detail: 'inhibited by X@1' },
        ]);
        expect(result.applied).toEqual([
          { ruleId: 'X', version: 1, kind: 'inhibit', affected: ['T'] },
          { ruleId: 'A', version: 1, kind: 'substitute', affected: [] },
          { ruleId: 'B', version: 1, kind: 'substitute', affected: [] },
        ]);
        expectInvariants(order, result);
      }
    });

    it('names every rule of a substitution tie in throw mode', () => {
      const t = makeRule({ id: 'T', model: 'Rate', params: { rate: 0.5 } });
      const a = carrier('A', 500, [substitute(['T'], { rate: 0.1 })]);
      const b = carrier('B', 500, [substitute(['T'], { rate: 0.2 })]);
      const c = carrier('C', 500, [substitute(['T'], { rate: 0.3 })]);
      for (const order of permutations([t, a, b, c])) {
        try {
          processor.apply(order, 'throw');
          expect.unreachable('should have thrown');
        } catch (e) {
          if (!(e instanceof RuleConflictError)) throw e;
          expect(e.ruleIds).toEqual(['A', 'B', 'C']);
        }
      }
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
        ['riskLevel', { rule: sc, value: 'high', reason: 'blacklisted', declaration: RISK }],
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'SC', version: 1, kind: 'shortCircuit', affected: ['R1'] },
      ]);
    });

    it('omits reason when the exception has none, and records an empty affected list', () => {
      const sc = carrier('SC', 9000, [{ kind: 'shortCircuit', output: 'value', value: 0 }]);
      const result = processor.apply([sc], 'throw');
      expect(result.shortCircuits.get('value')).toEqual({
        rule: sc,
        value: 0,
        declaration: DEFAULT_OUTPUT_DECLARATION,
      });
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
      const r1 = risk('R1');
      const result = processor.apply([low, r1, high], 'throw');
      expect(result.shortCircuits.get('riskLevel')).toEqual({
        rule: high,
        value: 'high',
        declaration: RISK,
      });
      expect(result.skipped).toEqual([
        {
          rule: r1,
          reason: 'SHORT_CIRCUITED',
          detail: 'output riskLevel short-circuited by SC-high@1',
        },
      ]);
      expect(result.applied).toEqual([
        { ruleId: 'SC-high', version: 1, kind: 'shortCircuit', affected: ['R1'] },
        { ruleId: 'SC-low', version: 1, kind: 'shortCircuit', affected: [] },
      ]);
      expectInvariants([low, r1, high], result);
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
        {
          rule: r1,
          reason: 'SHORT_CIRCUITED',
          detail: 'output riskLevel short-circuited by SC@1; also inhibited by I@1',
        },
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
      expect(expected.shortCircuits.get('riskLevel')).toEqual({
        rule: a,
        value: 'high',
        declaration: RISK,
      });
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

    it('skips the carrier with OUTPUT_MISMATCH on an output no rule in play declares', () => {
      const sc = carrier('SC', 9000, [
        { kind: 'shortCircuit', output: 'flags', value: { any: ['thing'] } },
      ]);
      const result = processor.apply([sc], 'throw');
      expect(result.skipped).toEqual([
        {
          rule: sc,
          reason: 'OUTPUT_MISMATCH',
          detail: 'shortCircuit of SC@1 on output flags: no rule in play declares output flags',
        },
      ]);
      expect(result.shortCircuits.size).toBe(0);
      expect(result.applied).toEqual([]);
    });

    it('skips the carrier with OUTPUT_MISMATCH when the rules feeding the output disagree', () => {
      const sc = carrier('SC', 9000, [
        { kind: 'shortCircuit', output: 'riskLevel', value: 'high' },
      ]);
      const r1 = risk('R1');
      const n1 = makeRule({ id: 'N1', model: 'M', output: 'riskLevel' });
      const result = processor.apply([n1, sc, r1], 'throw');
      expect(result.skipped).toEqual([
        {
          rule: sc,
          reason: 'OUTPUT_MISMATCH',
          detail:
            'shortCircuit of SC@1 on output riskLevel: the rules feeding it declare it differently (enum/highestPriority (low, high), number/sum)',
        },
      ]);
      expect(result.rules).toEqual([n1, r1]);
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
      expectInvariants(fixture, expected);
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

describe('ExceptionProcessor short-circuits on decimal outputs (R38)', () => {
  const registry = makeRegistry();
  registry.register(
    new ValueModel(
      'Amount',
      { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'halfUp' } },
      {},
    ),
  );
  const processor = new ExceptionProcessor(registry);
  const amount = makeRule({ id: 'A', model: 'Amount', output: 'amount' });
  const expected =
    'does not match type decimal: expected a decimal string (an optional "-", digits, ' +
    'an optional "." and digits, no exponent) or a safe integer';

  it('accepts a decimal string or a safe integer', () => {
    for (const value of ['0012.50', 12, '-3']) {
      const sc = carrier('SC', 9000, [{ kind: 'shortCircuit', output: 'amount', value }]);
      const result = processor.apply([sc, amount], 'throw');
      expect(result.shortCircuits.get('amount')?.value).toBe(value);
      expect(result.skipped.map((s) => s.reason)).toEqual(['SHORT_CIRCUITED']);
    }
  });

  it('skips the carrier with OUTPUT_MISMATCH on a float, an exponent or text', () => {
    for (const [value, written] of [
      [0.5, '0.5'],
      ['1e3', '"1e3"'],
      ['abc', '"abc"'],
    ] as const) {
      const sc = carrier('SC', 9000, [{ kind: 'shortCircuit', output: 'amount', value }]);
      const result = processor.apply([sc, amount], 'throw');
      expect(result.shortCircuits.size).toBe(0);
      expect(result.rules).toEqual([amount]);
      expect(result.skipped).toEqual([
        {
          rule: sc,
          reason: 'OUTPUT_MISMATCH',
          detail: `shortCircuit of SC@1 on output amount: value ${written} ${expected}`,
        },
      ]);
    }
  });
});
