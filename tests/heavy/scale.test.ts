import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { InputSanitizer } from '../../src/security/InputSanitizer.js';
import { EngineLimitError } from '../../src/errors/EngineLimitError.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { InputCopier } from '../../src/input/copyInput.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, makeInput, StubModel, StubPlugin } from '../helpers.js';
import type { PPEPlugin } from '../../src/types/plugin.js';

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
      makeRule({ id: `r${i}`, model: 'm', priority: i }),
    );
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)])],
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
    const rule = makeRule({ id: 'r', model: 'm' });
    const rules = new Array<typeof rule>(DEFAULT_LIMITS.maxRules + 1).fill(rule);
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)])],
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

describe('maxInputLeaves (500 000): the nodes of the input tree', () => {
  /** `entries` keys with a scalar each under one object: 2 nodes each, the costliest shape. */
  const entriesOf = (entries: number): Record<string, unknown> => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < entries; i += 1) data[`k${i}`] = i;
    return data;
  };
  const sanitize = (data: Record<string, unknown>): void =>
    InputSanitizer.validate({ requestId: 'r', data, meta: { tenantId: 't' } });

  // meta.tenantId is a key and a scalar too: data holds two nodes less.
  it('normalizes and checks an input of maxInputLeaves nodes in under 3 s', () => {
    const data = entriesOf((DEFAULT_LIMITS.maxInputLeaves - 2) / 2);
    const start = performance.now();
    sanitize(data);
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it('refuses one entry more, as soon as it is counted', () => {
    const data = entriesOf((DEFAULT_LIMITS.maxInputLeaves - 2) / 2 + 1);
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

describe('maxRuleLeaves (100 000): the nodes of one rule', () => {
  /** The nodes of a rule as the engine counts them when it reads a rule. */
  const nodesOf = (rule: Rule): number => {
    const copier = new InputCopier(
      { ...DEFAULT_LIMITS, maxRuleLeaves: Number.MAX_SAFE_INTEGER },
      'maxRuleLeaves',
      true,
      true,
    );
    copier.copy(rule, 'rule');
    return copier.leaves;
  };
  const padded = (items: number): Rule =>
    makeRule({ id: 'big', model: 'm', params: { pad: new Array<number>(items).fill(1) } });
  /** The rule with exactly `nodes` nodes (a list of scalars: 1 node each). */
  const withNodes = (nodes: number): Rule => padded(nodes - nodesOf(padded(0)));
  const engine = (): PPEEngine =>
    new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)])],
      dsls: [],
      strict: false,
    });

  it('reads and evaluates a rule of maxRuleLeaves nodes in under 3 s', async () => {
    const rule = withNodes(DEFAULT_LIMITS.maxRuleLeaves);
    const start = performance.now();
    const result = await engine().evaluate([rule], makeInput());
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(result.appliedRules).toHaveLength(1);
  }, 60_000);

  it('refuses one node more, as soon as it is counted', async () => {
    const error = await failureOf(() =>
      engine().evaluate([withNodes(DEFAULT_LIMITS.maxRuleLeaves + 1)], makeInput()),
    );
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRuleLeaves', max: 100_000, actual: 100_001 });
  }, 60_000);
});

describe('maxRules (100 000) with plugins: three beforeEvaluate hooks and one afterEvaluate', () => {
  /** A hook that hands everything back, as an identity plugin does. */
  const identity = (name: string): PPEPlugin => ({
    name,
    version: '1.0.0',
    onInit: () => undefined,
    beforeEvaluate: (input, rules) => ({ input, rules }),
  });

  it('evaluates maxRules simple rules in under 10 s', async () => {
    const rules = Array.from({ length: DEFAULT_LIMITS.maxRules }, (_, i) =>
      makeRule({ id: `r${i}`, model: 'm', priority: i }),
    );
    const after: PPEPlugin = {
      name: 'after',
      version: '1.0.0',
      onInit: () => undefined,
      afterEvaluate: () => undefined,
    };
    const engine = new PPEEngine({
      plugins: [
        new StubPlugin('p', [new StubModel('m', 1)]),
        identity('one'),
        identity('two'),
        identity('three'),
        after,
      ],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const result = await engine.evaluate(rules, makeInput());
    const elapsed = performance.now() - start;
    expect(result.appliedRules).toHaveLength(DEFAULT_LIMITS.maxRules);
    expect(elapsed).toBeLessThan(10_000);
  }, 120_000);
});

describe('the costliest shape: wide objects (about 48 000 keys per rule)', () => {
  /** A rule whose params are one object of `keys` keys: 2 nodes each. */
  const wide = (id: string, keys: number): Rule => {
    const params: Record<string, number> = {};
    for (let i = 0; i < keys; i += 1) params[`k${i}`] = i;
    return makeRule({ id, model: 'm', params });
  };
  const nodesOf = (rule: Rule): number => {
    const copier = new InputCopier(
      { ...DEFAULT_LIMITS, maxRuleLeaves: Number.MAX_SAFE_INTEGER },
      'maxRuleLeaves',
      true,
      true,
    );
    copier.copy(rule, 'rule');
    return copier.leaves;
  };
  const engineWith = (adder?: PPEPlugin): PPEEngine =>
    new PPEEngine({
      plugins: [
        new StubPlugin('p', [new StubModel('m', 1)]),
        ...(adder === undefined ? [] : [adder]),
      ],
      dsls: [],
      strict: false,
    });

  it('evaluates caller rules of maxRuleSetNodes nodes in under 10 s, with no plugin', async () => {
    const one = wide('w0', 48_000);
    const per = nodesOf(one);
    const count = Math.floor(DEFAULT_LIMITS.maxRuleSetNodes / per);
    const rules = [one, ...Array.from({ length: count - 1 }, (_, i) => wide(`w${i + 1}`, 48_000))];
    const start = performance.now();
    const result = await engineWith().evaluate(rules, makeInput());
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(result.appliedRules).toHaveLength(count);
  }, 120_000);

  it('refuses one rule more, as soon as the bound is passed', async () => {
    const per = nodesOf(wide('w', 48_000));
    const count = Math.floor(DEFAULT_LIMITS.maxRuleSetNodes / per) + 1;
    const rules = Array.from({ length: count }, (_, i) => wide(`w${i}`, 48_000));
    const start = performance.now();
    const error = await failureOf(() => engineWith().evaluate(rules, makeInput()));
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(error).toMatchObject({ limit: 'maxRuleSetNodes', max: DEFAULT_LIMITS.maxRuleSetNodes });
  }, 120_000);

  it('reads, validates and evaluates a hook return of maxHookLeaves wide nodes in under 8 s (costliest shape)', async () => {
    const per = nodesOf(wide('h', 48_000));
    const count = Math.floor(DEFAULT_LIMITS.maxHookLeaves / per);
    const added = Array.from({ length: count }, (_, i) => wide(`h${i}`, 48_000));
    const adder: PPEPlugin = {
      name: 'adder',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: (input, rules) => ({ input, rules: [...rules, ...added] }),
    };
    const start = performance.now();
    const result = await engineWith(adder).evaluate(
      [makeRule({ id: 'one', model: 'm' })],
      makeInput(),
    );
    expect(performance.now() - start).toBeLessThan(8_000);
    expect(result.appliedRules).toHaveLength(count + 1);
  }, 120_000);
});

describe('the worst case: every limit at its default, on the costliest shape, at once (V4)', () => {
  const text = 'x'.repeat(DEFAULT_LIMITS.maxStringLength);
  const nodesOf = (rule: Rule): number => {
    const copier = new InputCopier(
      { ...DEFAULT_LIMITS, maxRuleLeaves: Number.MAX_SAFE_INTEGER },
      'maxRuleLeaves',
      true,
      true,
    );
    copier.copy(rule, 'rule');
    return copier.leaves;
  };
  const wide = (id: string, keys: number): Rule => {
    const params: Record<string, number> = {};
    for (let i = 0; i < keys; i += 1) params[`k${i}`] = i;
    return makeRule({ id, model: 'm', params });
  };
  /** Text that JSON escapes six-fold: it weighs what it costs, not what it counts. */
  const escaped = '\u0001'.repeat(100_000);
  const escapedRule = (id: string): Rule => makeRule({ id, model: 'm', params: { escaped } });
  /** A rule carrying one string of `maxStringLength` characters (the same string in all of them). */
  const texty = (id: string): Rule => makeRule({ id, model: 'm', params: { text } });
  it('pins the calibrated defaults by value', () => {
    expect(DEFAULT_LIMITS.maxRuleSetNodes).toBe(2_000_000);
    expect(DEFAULT_LIMITS.maxHookLeaves).toBe(400_000);
    expect(DEFAULT_LIMITS.maxTraceNodes).toBe(10_000_000);
    expect(DEFAULT_LIMITS.maxStringLength).toBe(1_000_000);
  });

  it('caller rules at maxRuleSetNodes, a hook at maxHookLeaves, an input at the size maxTraceNodes allows, strings at maxStringLength: under 10 s', async () => {
    const wideNodes = nodesOf(wide('w', 48_000));
    const textyNodes = nodesOf(texty('t'));
    // Caller rules: 6 rules with the long string, then wide rules up to the bound.
    const callerTexty = 6;
    const callerEscaped = 3;
    const escapedNodes = nodesOf(escapedRule('e'));
    const callerWide = Math.floor(
      (DEFAULT_LIMITS.maxRuleSetNodes - callerTexty * textyNodes - callerEscaped * escapedNodes) /
        wideNodes,
    );
    const rules = [
      ...Array.from({ length: callerTexty }, (_, i) => texty(`ct${i}`)),
      ...Array.from({ length: callerEscaped }, (_, i) => escapedRule(`ce${i}`)),
      ...Array.from({ length: callerWide }, (_, i) => wide(`cw${i}`, 48_000)),
    ];
    // The input: wide data and one long string, small enough that its nodes times the steps of the
    // trace stay under maxTraceNodes (it is read again by the hook, and counts against its bound).
    const inputTarget = 30_000;
    const textInput = Math.floor(text.length / 64) + 2;
    const entries = Math.floor((inputTarget - 2 - textInput) / 2);
    const data: Record<string, unknown> = { text };
    for (let i = 0; i < entries; i += 1) data[`k${i}`] = i;
    // One hook adds rules up to its own bound: the input it returns counts first, then 4 rules
    // with the long string, then wide rules.
    const hookTexty = 4;
    const hookEscaped = 2;
    const hookWide = Math.floor(
      (DEFAULT_LIMITS.maxHookLeaves -
        inputTarget -
        hookTexty * textyNodes -
        hookEscaped * escapedNodes) /
        wideNodes,
    );
    const added = [
      ...Array.from({ length: hookTexty }, (_, i) => texty(`ht${i}`)),
      ...Array.from({ length: hookEscaped }, (_, i) => escapedRule(`he${i}`)),
      ...Array.from({ length: hookWide }, (_, i) => wide(`hw${i}`, 48_000)),
    ];
    expect(inputTarget * (rules.length + added.length)).toBeLessThan(DEFAULT_LIMITS.maxTraceNodes);
    const adder: PPEPlugin = {
      name: 'adder',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: (input, current) => ({ input, rules: [...current, ...added] }),
    };
    const after: PPEPlugin = {
      name: 'after',
      version: '1.0.0',
      onInit: () => undefined,
      afterEvaluate: () => undefined,
    };
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)]), adder, after],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const result = await engine.evaluate(rules, makeInput({ data }));
    const elapsed = performance.now() - start;
    expect(result.appliedRules).toHaveLength(rules.length + added.length);
    expect(elapsed).toBeLessThan(10_000);
  }, 180_000);

  it('an input of maxInputLeaves nodes with a hundred rules is refused by maxTraceNodes, quickly', async () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < (DEFAULT_LIMITS.maxInputLeaves - 2) / 2; i += 1) data[`k${i}`] = i;
    const rules = Array.from({ length: 100 }, (_, i) => makeRule({ id: `r${i}`, model: 'm' }));
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)])],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const error = await engine.evaluate(rules, makeInput({ data })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxTraceNodes', max: DEFAULT_LIMITS.maxTraceNodes });
  }, 60_000);

  it('every limit is reachable on its own: an input of maxInputLeaves nodes with 20 rules is evaluated in under 10 s', async () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < (DEFAULT_LIMITS.maxInputLeaves - 2) / 2; i += 1) data[`k${i}`] = i;
    const rules = Array.from({ length: 20 }, (_, i) => makeRule({ id: `r${i}`, model: 'm' }));
    // 20 steps of the trace, each recording an input of 500 000 nodes: the product stays under
    // maxTraceNodes, so that the input limit decides before the trace limit does.
    expect(DEFAULT_LIMITS.maxInputLeaves * rules.length).toBeLessThanOrEqual(
      DEFAULT_LIMITS.maxTraceNodes,
    );
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)])],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const result = await engine.evaluate(rules, makeInput({ data }));
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(result.appliedRules).toHaveLength(20);
  }, 120_000);

  it('T5: rules sharing a string of control characters are refused by name long before the budget of time', async () => {
    const hostile = '\u0001'.repeat(DEFAULT_LIMITS.maxStringLength);
    const rules = Array.from({ length: 100 }, (_, i) =>
      makeRule({ id: `t${i}`, model: 'm', params: { hostile } }),
    );
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)])],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const error = await engine.evaluate(rules, makeInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxRuleSetNodes' });
  }, 60_000);

  it('Xs: 2 200 skips sharing a text of maxStringLength characters are refused by name, not a crash', async () => {
    const detail = 'd'.repeat(DEFAULT_LIMITS.maxStringLength);
    const rules = Array.from({ length: 2_200 }, (_, i) => makeRule({ id: `s${i}`, model: 'm' }));
    const skipper: PPEPlugin = {
      name: 'skipper',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: (input, current) => ({
        input,
        rules: [],
        skipped: current.map((rule) => ({ rule, reason: 'PLUGIN' as const, detail })),
      }),
    };
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)]), skipper],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const error = await engine.evaluate(rules, makeInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(performance.now() - start).toBeLessThan(5_000);
    expect((error as { cause?: unknown }).cause).toMatchObject({ name: 'EngineLimitError' });
    expect((error as { cause: unknown }).cause).toMatchObject({
      message: expect.stringContaining('engine limit maxHookLeaves exceeded'),
    });
  }, 60_000);

  it('Xb5: 2 200 rules whose model answers with the same long error are refused by name, not a crash', async () => {
    const errors = ['e'.repeat(DEFAULT_LIMITS.maxStringLength)];
    const wordy = {
      name: 'wordy',
      version: '1.0.0',
      validateParams: () => ({ valid: false, errors }),
      calculate: () => 1,
    };
    const rules = Array.from({ length: 2_200 }, (_, i) =>
      makeRule({ id: `v${i}`, model: 'wordy' }),
    );
    const engine = new PPEEngine({
      plugins: [
        {
          name: 'w',
          version: '1.0.0',
          onInit: (context) => context.modelRegistry.register(wordy),
        },
      ],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const error = await engine.evaluate(rules, makeInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(EngineLimitError);
    expect(error).toMatchObject({ limit: 'maxHookLeaves' });
  }, 60_000);

  it('W3: three afterEvaluate plugins that each set 20 shared texts of control characters are refused by name, quickly', async () => {
    const hostile = '\u0001'.repeat(DEFAULT_LIMITS.maxStringLength);
    const annotating = (name: string): PPEPlugin => ({
      name,
      version: '1.0.0',
      onInit: () => undefined,
      afterEvaluate: () => ({ annotations: { texts: Array.from({ length: 20 }, () => hostile) } }),
    });
    const engine = new PPEEngine({
      plugins: [
        new StubPlugin('p', [new StubModel('m', 1)]),
        annotating('one'),
        annotating('two'),
        annotating('three'),
      ],
      dsls: [],
      strict: false,
    });
    const rules = Array.from({ length: 8 }, (_, i) => makeRule({ id: `a${i}`, model: 'm' }));
    const start = performance.now();
    const error = await engine.evaluate(rules, makeInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(performance.now() - start).toBeLessThan(5_000);
    expect((error as { cause?: unknown }).cause).toMatchObject({ name: 'EngineLimitError' });
    // One meta of 20 such texts is already past the bound of one read; the budget of the
    // evaluation catches what several plugins add together.
    expect(['maxInputLeaves', 'maxHookLeaves']).toContain(
      ((error as { cause: { limit: string } }).cause as { limit: string }).limit,
    );
  }, 60_000);

  it('AB3: an input of maxInputLeaves nodes with 20 rules and five annotators is evaluated in under 10 s', async () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < (DEFAULT_LIMITS.maxInputLeaves - 2) / 2; i += 1) data[`k${i}`] = i;
    const rules = Array.from({ length: 20 }, (_, i) => makeRule({ id: `r${i}`, model: 'm' }));
    const annotating = (name: string): PPEPlugin => ({
      name,
      version: '1.0.0',
      onInit: () => undefined,
      afterEvaluate: () => ({ annotations: { seen: 1 } }),
    });
    const engine = new PPEEngine({
      plugins: [
        new StubPlugin('p', [new StubModel('m', 1)]),
        ...['one', 'two', 'three', 'four', 'five'].map(annotating),
      ],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const result = await engine.evaluate(rules, makeInput({ data }));
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(Object.keys(result.meta ?? {}).sort()).toEqual(['five', 'four', 'one', 'three', 'two']);
  }, 120_000);

  it('many rules sharing one string of maxStringLength characters: finishes or is refused by name, under 10 s', async () => {
    const rules = Array.from({ length: 100 }, (_, i) => texty(`s${i}`));
    const engine = new PPEEngine({
      plugins: [new StubPlugin('p', [new StubModel('m', 1)])],
      dsls: [],
      strict: false,
    });
    const start = performance.now();
    const outcome = await engine.evaluate(rules, makeInput()).then(
      (result) => result,
      (error: unknown) => error,
    );
    expect(performance.now() - start).toBeLessThan(10_000);
    if (outcome instanceof Error) {
      expect(outcome).toBeInstanceOf(EngineLimitError);
    }
  }, 180_000);
});
