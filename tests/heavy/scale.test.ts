import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { InputCopier } from '../../src/input/copyInput.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, makeInput, StubModel, StubPlugin } from '../helpers.js';

// The scale tests of D-26: each default limit is held at its value, with a written budget. They
// read a clock, so they run in the heavy project (`npm run test:heavy`), one file at a time.

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => undefined,
    (error: unknown) => error,
  );

describe('maxRules (100 000): the rules of one evaluation', () => {
  it('evaluates maxRules simple rules on a small input in under 10 s', async () => {
    const rules = Array.from({ length: DEFAULT_LIMITS.maxRules }, (_, i) =>
      makeRule({ id: `r${i}`, model: 'M', priority: i }),
    );
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('M', 1)])],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const result = await engine.evaluate(rules, makeInput());
    const elapsed = performance.now() - start;
    expect(result.appliedRules).toHaveLength(DEFAULT_LIMITS.maxRules);
    expect(result.value).toBe(DEFAULT_LIMITS.maxRules);
    expect(elapsed).toBeLessThan(10_000);
  }, 120_000);

  it('refuses one rule more at once, without reading any of them', async () => {
    const rule = makeRule({ id: 'r', model: 'M' });
    const rules = new Array<typeof rule>(DEFAULT_LIMITS.maxRules + 1).fill(rule);
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('M', 1)])],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const error = await failureOf(() => engine.evaluate(rules, makeInput()));
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRules', max: 100_000, actual: 100_001 });
  });
});

describe('maxInputLeaves (500 000): the leaves of the input tree', () => {
  /** `count` scalar leaves under groups of 1000 (the last group holds the rest). */
  const leavesOf = (count: number): Record<string, unknown> => {
    const data: Record<string, unknown> = {};
    for (let group = 0; group * 1000 < count; group++) {
      const row: Record<string, unknown> = {};
      for (let key = 0; key < Math.min(1000, count - group * 1000); key++) row[`k${key}`] = key;
      data[`g${group}`] = row;
    }
    return data;
  };
  const sanitize = (data: Record<string, unknown>): void =>
    InputSanitizer.validate({ requestId: 'r', data, meta: { tenantId: 't' } });

  // meta.tenantId is a leaf of the input too: data holds one less.
  it('normalizes and checks an input of maxInputLeaves leaves in under 3 s', () => {
    const data = leavesOf(DEFAULT_LIMITS.maxInputLeaves - 1);
    const start = performance.now();
    sanitize(data);
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it('refuses one leaf more, as soon as it is counted', () => {
    const data = leavesOf(DEFAULT_LIMITS.maxInputLeaves - 1);
    data['one more'] = 1;
    let error: unknown;
    try {
      sanitize(data);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxInputLeaves', max: 500_000, actual: 500_001 });
  });
});

describe('maxInputDepth (128): the levels of the input', () => {
  const deep = (levels: number): Record<string, unknown> => {
    let value: Record<string, unknown> = { leaf: 1 };
    for (let i = 1; i < levels; i++) value = { a: value };
    return value;
  };

  it('checks an input of maxInputDepth levels, and refuses one more', () => {
    const check = (data: Record<string, unknown>): void =>
      InputSanitizer.validate({ requestId: 'r', data, meta: { tenantId: 't' } });
    expect(() => check(deep(DEFAULT_LIMITS.maxInputDepth))).not.toThrow();
    expect(() => check(deep(DEFAULT_LIMITS.maxInputDepth + 1))).toThrow(EngineLimitError);
  });
});

describe('maxRuleLeaves (100 000): the leaves of one rule', () => {
  const padded = (extra: number): Rule => {
    const rule = makeRule({ id: 'big', model: 'M' });
    const copier = new InputCopier({
      ...DEFAULT_LIMITS,
      maxInputLeaves: Number.MAX_SAFE_INTEGER,
      maxRuleLeaves: Number.MAX_SAFE_INTEGER,
    });
    copier.copy(rule, 'rule');
    // `pad` is a list (one leaf) of scalars, replacing the empty `params` (one leaf): the rule then
    // has base + items leaves.
    const items = DEFAULT_LIMITS.maxRuleLeaves - copier.leaves + extra;
    return makeRule({ id: 'big', model: 'M', params: { pad: new Array<number>(items).fill(1) } });
  };
  const engine = (): PPEEngine =>
    new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('M', 1)])],
      dsls: [],
      strict: false,
    });

  it('reads and evaluates a rule of maxRuleLeaves leaves in under 3 s', async () => {
    const rule = padded(0);
    const start = performance.now();
    const result = await engine().evaluate([rule], makeInput());
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(result.appliedRules).toHaveLength(1);
  }, 60_000);

  it('refuses one leaf more, as soon as it is counted', async () => {
    const error = await failureOf(() => engine().evaluate([padded(1)], makeInput()));
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRuleLeaves', max: 100_000, actual: 100_001 });
  }, 60_000);
});
