import { DEFAULT_LIMITS } from '../../src/limits.js';
import { describe, it, expect } from 'vitest';
import { EXCEPTION_MODEL } from '@run-iq/spec';
import type { JsonValue, OutputDeclaration } from '@run-iq/spec';
import { ExecutionPipeline } from '../../src/engine/ExecutionPipeline.js';
import type { ShortCircuit } from '../../src/engine/ExceptionProcessor.js';
import { TraceBuilder } from '../../src/engine/TraceBuilder.js';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import type { CalculationModel, CalculationOutput } from '../../src/types/model.js';
import { OutputNotFiniteError } from '../../src/errors/OutputNotFiniteError.js';
import { DecimalPrecisionError } from '../../src/errors/DecimalPrecisionError.js';
import type { OutputValue } from '../../src/types/output.js';
import { makeRule, makeInput, StubModel, ValueModel } from '../helpers.js';

const RISK: OutputDeclaration = {
  type: 'enum',
  combine: 'highestPriority',
  values: ['low', 'high'],
};

const NONE: ReadonlyMap<string, ShortCircuit> = new Map();

function pipelineWith(...models: CalculationModel<OutputValue>[]): ExecutionPipeline {
  const registry = new ModelRegistry();
  for (const model of models) registry.register(model);
  return new ExecutionPipeline(registry, 'throw', DEFAULT_LIMITS);
}

describe('ExecutionPipeline', () => {
  it('executes rules without output into value, a number combined by sum', () => {
    const pipeline = pipelineWith(new StubModel('M1', 100), new StubModel('M2', 200));
    const rules = [makeRule({ id: 'r1', model: 'M1' }), makeRule({ id: 'r2', model: 'M2' })];

    const result = pipeline.execute(rules, makeInput(), new TraceBuilder(), NONE);
    expect(result.outputs).toEqual({
      value: {
        name: 'value',
        type: 'number',
        combine: 'sum',
        value: 300,
        contributors: ['r1', 'r2'],
      },
    });
    expect(result.applied.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(result.breakdown.map((b) => [b.ruleId, b.output, b.contribution])).toEqual([
      ['r1', 'value', 100],
      ['r2', 'value', 200],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('aggregates decimal values without floating-point drift', () => {
    const pipeline = pipelineWith(new StubModel('A', 0.1), new StubModel('B', 0.2));
    const rules = [makeRule({ id: 'r1', model: 'A' }), makeRule({ id: 'r2', model: 'B' })];
    const result = pipeline.execute(rules, makeInput(), new TraceBuilder(), NONE);
    expect(result.outputs['value']?.value).toBe(0.3);
  });

  it('gives value 0 with no contributor when no rule feeds it', () => {
    const result = pipelineWith().execute([], makeInput(), new TraceBuilder(), NONE);
    expect(result).toEqual({
      outputs: {
        value: { name: 'value', type: 'number', combine: 'sum', value: 0, contributors: [] },
      },
      breakdown: [],
      applied: [],
      skipped: [],
    });
  });

  it('carries output, ruleVersion and sourceRef in the breakdown and the trace', () => {
    const pipeline = pipelineWith(
      new StubModel('M', 50),
      new ValueModel('RISK', RISK, { r2: { value: 'high', detail: 'scored' } }),
    );
    const trace = new TraceBuilder();
    const rules = [
      makeRule({ id: 'r1', model: 'M', version: 3, sourceRef: 'CGI art. 12' }),
      makeRule({ id: 'r2', model: 'RISK', output: 'risk' }),
    ];
    const result = pipeline.execute(rules, makeInput(), trace, NONE);

    expect(result.breakdown).toEqual([
      {
        ruleId: 'r1',
        ruleVersion: 3,
        sourceRef: 'CGI art. 12',
        output: 'value',
        contribution: 50,
        modelUsed: 'M',
        detail: undefined,
      },
      {
        ruleId: 'r2',
        ruleVersion: 1,
        output: 'risk',
        contribution: 'high',
        modelUsed: 'RISK',
        detail: 'scored',
      },
    ]);
    expect(result.breakdown.map((b) => [b.ruleId, b.ruleVersion, b.output, b.sourceRef])).toEqual([
      ['r1', 3, 'value', 'CGI art. 12'],
      ['r2', 1, 'risk', undefined],
    ]);
    expect('sourceRef' in result.breakdown[1]!).toBe(false);
    const steps = trace.build().steps;
    expect(
      steps.map((s) => [s.ruleId, s.ruleVersion, s.output, s.sourceRef, s.contribution]),
    ).toEqual([
      ['r1', 3, 'value', 'CGI art. 12', 50],
      ['r2', 1, 'risk', undefined, 'high'],
    ]);
    expect('sourceRef' in steps[1]!).toBe(false);
    expect(result.outputs['risk']).toEqual({
      name: 'risk',
      type: 'enum',
      combine: 'highestPriority',
      value: 'high',
      contributors: ['r2'],
    });
  });

  it('orders applied, breakdown and trace by priority descending then id@version', () => {
    const pipeline = pipelineWith(new StubModel('M', 1));
    const trace = new TraceBuilder();
    const rules = [
      makeRule({ id: 'b', model: 'M', priority: 100 }),
      makeRule({ id: 'a', model: 'M', priority: 100, version: 2 }),
      makeRule({ id: 'z', model: 'M', priority: 900 }),
      makeRule({ id: 'a', model: 'M', priority: 100, version: 1 }),
    ];
    const result = pipeline.execute(rules, makeInput(), trace, NONE);
    const expected = ['z@1', 'a@1', 'a@2', 'b@1'];
    expect(result.applied.map((r) => `${r.id}@${r.version}`)).toEqual(expected);
    expect(trace.build().steps.map((s) => `${s.ruleId}@${s.ruleVersion}`)).toEqual(expected);
    expect(result.breakdown.map((b) => b.ruleId)).toEqual(['z', 'a', 'a', 'b']);
    expect(result.outputs['value']?.contributors).toEqual(['z', 'a', 'b']);
  });

  describe('declarations', () => {
    it('excludes every rule feeding an output declared differently, without computing them', () => {
      const scored = new ValueModel('SCORED', RISK, { a: 'high' });
      const labelled = new ValueModel(
        'LABELLED',
        { type: 'string', combine: 'highestPriority' },
        { b: 'high' },
      );
      const pipeline = pipelineWith(scored, labelled, new StubModel('M', 10));
      const a = makeRule({ id: 'a', model: 'SCORED', output: 'risk' });
      const b = makeRule({ id: 'b', model: 'LABELLED', output: 'risk' });
      const result = pipeline.execute(
        [b, makeRule({ id: 'v', model: 'M' }), a],
        makeInput(),
        new TraceBuilder(),
        NONE,
      );
      const detail =
        'rules feeding output risk declare it differently: ' +
        'a@1 enum/highestPriority (low, high); b@1 string/highestPriority';
      expect(result.skipped).toEqual([
        { rule: a, reason: 'OUTPUT_MISMATCH', detail },
        { rule: b, reason: 'OUTPUT_MISMATCH', detail },
      ]);
      expect(Object.keys(result.outputs)).toEqual(['value']);
      expect(result.applied.map((r) => r.id)).toEqual(['v']);
      expect([scored.calls, labelled.calls]).toEqual([0, 0]);
    });

    it('treats enum declarations listing values in another order as different', () => {
      const pipeline = pipelineWith(
        new ValueModel('A', RISK, { a: 'low' }),
        new ValueModel('B', { ...RISK, values: ['high', 'low'] }, { b: 'low' }),
      );
      const result = pipeline.execute(
        [
          makeRule({ id: 'a', model: 'A', output: 'risk' }),
          makeRule({ id: 'b', model: 'B', output: 'risk' }),
        ],
        makeInput(),
        new TraceBuilder(),
        NONE,
      );
      expect(result.skipped.map((s) => s.reason)).toEqual(['OUTPUT_MISMATCH', 'OUTPUT_MISMATCH']);
      expect(result.outputs['risk']).toBeUndefined();
    });

    it('excludes a computed value out of the declared type with OUTPUT_MISMATCH', () => {
      const pipeline = pipelineWith(new ValueModel('RISK', RISK, { a: 'low', b: 'unknown' }));
      const b = makeRule({ id: 'b', model: 'RISK', output: 'risk' });
      const trace = new TraceBuilder();
      const result = pipeline.execute(
        [makeRule({ id: 'a', model: 'RISK', output: 'risk', priority: 1 }), b],
        makeInput(),
        trace,
        NONE,
      );
      expect(result.skipped).toEqual([
        {
          rule: b,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output risk: value "unknown" does not match type enum (low, high)',
        },
      ]);
      expect(result.outputs['risk']?.value).toBe('low');
      expect(result.applied.map((r) => r.id)).toEqual(['a']);
      expect(trace.build().steps.map((s) => s.ruleId)).toEqual(['a']);
      expect(result.breakdown.map((s) => s.ruleId)).toEqual(['a']);
    });

    it('excludes a value that is not JSON with OUTPUT_MISMATCH', () => {
      // A JavaScript model can return a Date; typed code cannot, hence Object.create.
      const withDate: OutputValue = Object.assign(Object.create(null), { at: new Date(0) });
      const pipeline = pipelineWith(
        new ValueModel('OBJ', { type: 'object', combine: 'highestPriority' }, { a: withDate }),
        new StubModel('NAN', NaN),
      );
      const a = makeRule({ id: 'a', model: 'OBJ', output: 'terms' });
      const n = makeRule({ id: 'n', model: 'NAN' });
      const result = pipeline.execute([a, n], makeInput(), new TraceBuilder(), NONE);
      expect(result.skipped).toEqual([
        {
          rule: a,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output terms: the value is not JSON at $.at (Date)',
        },
        {
          rule: n,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output value: the value is not JSON at $ (NaN)',
        },
      ]);
      expect(result.outputs).toEqual({
        value: { name: 'value', type: 'number', combine: 'sum', value: 0, contributors: [] },
      });
    });

    it('reads a plain object with only value and detail as a CalculationOutput', () => {
      const object: OutputDeclaration = { type: 'object', combine: 'highestPriority' };
      const pipeline = pipelineWith(
        new ValueModel('WRAPPED', object, { a: { value: { rate: 1 }, detail: 'why' } }),
        new ValueModel('BARE', object, { b: { value: 2, rate: 3 } }),
      );
      const result = pipeline.execute(
        [
          makeRule({ id: 'a', model: 'WRAPPED', output: 'x' }),
          makeRule({ id: 'b', model: 'BARE', output: 'y' }),
        ],
        makeInput(),
        new TraceBuilder(),
        NONE,
      );
      expect(result.outputs['x']?.value).toEqual({ rate: 1 });
      expect(result.outputs['y']?.value).toEqual({ value: 2, rate: 3 });
      expect(result.breakdown.map((b) => b.detail)).toEqual(['why', undefined]);
    });
  });

  describe('short-circuits', () => {
    it('gives a short-circuited output the imposed value, its carrier as only contributor', () => {
      const pipeline = pipelineWith(new StubModel('M', 10));
      const carrier = makeRule({
        id: 'X',
        model: EXCEPTION_MODEL,
        priority: 9000,
        sourceRef: 'decree 7',
        exceptions: [
          { kind: 'shortCircuit', output: 'risk', value: 'high', reason: 'blacklisted' },
        ],
      });
      const shortCircuits = new Map<string, ShortCircuit>([
        ['risk', { rule: carrier, value: 'high', reason: 'blacklisted', declaration: RISK }],
      ]);
      const trace = new TraceBuilder();
      const result = pipeline.execute(
        [makeRule({ id: 'v', model: 'M' })],
        makeInput(),
        trace,
        shortCircuits,
      );
      expect(result.outputs).toEqual({
        risk: {
          name: 'risk',
          type: 'enum',
          combine: 'highestPriority',
          value: 'high',
          contributors: ['X'],
        },
        value: { name: 'value', type: 'number', combine: 'sum', value: 10, contributors: ['v'] },
      });
      expect(result.applied.map((r) => r.id)).toEqual(['v']);
      expect(result.breakdown).toEqual([
        {
          ruleId: 'X',
          ruleVersion: 1,
          sourceRef: 'decree 7',
          output: 'risk',
          contribution: 'high',
          modelUsed: EXCEPTION_MODEL,
          detail: { shortCircuit: 'blacklisted' },
        },
        {
          ruleId: 'v',
          ruleVersion: 1,
          output: 'value',
          contribution: 10,
          modelUsed: 'M',
          detail: undefined,
        },
      ]);
      const step = trace.build().steps[0]!;
      expect([
        step.ruleId,
        step.ruleVersion,
        step.output,
        step.sourceRef,
        step.contribution,
      ]).toEqual(['X', 1, 'risk', 'decree 7', 'high']);
      expect(step.detail).toEqual({ shortCircuit: 'blacklisted' });
    });

    it('drops the contribution of a computing carrier to its own short-circuited output', () => {
      const risk = new ValueModel('RISK', RISK, { C: 'low' });
      const pipeline = pipelineWith(risk);
      const carrier = makeRule({
        id: 'C',
        model: 'RISK',
        output: 'risk',
        exceptions: [{ kind: 'shortCircuit', output: 'risk', value: 'high' }],
      });
      const result = pipeline.execute(
        [carrier],
        makeInput(),
        new TraceBuilder(),
        new Map([['risk', { rule: carrier, value: 'high', declaration: RISK }]]),
      );
      expect(risk.calls).toBe(0);
      expect(result.outputs['risk']).toEqual({
        name: 'risk',
        type: 'enum',
        combine: 'highestPriority',
        value: 'high',
        contributors: ['C'],
      });
      expect(result.applied).toEqual([carrier]);
      expect(result.breakdown).toEqual([
        {
          ruleId: 'C',
          ruleVersion: 1,
          output: 'risk',
          contribution: 'high',
          modelUsed: 'RISK',
          detail: { shortCircuit: null },
        },
      ]);
      expect(result.skipped).toEqual([]);
    });

    it('keeps a computing carrier contributing to its own output when it short-circuits another', () => {
      const pipeline = pipelineWith(new StubModel('M', 10));
      const carrier = makeRule({
        id: 'C',
        model: 'M',
        exceptions: [{ kind: 'shortCircuit', output: 'risk', value: 'low' }],
      });
      const result = pipeline.execute(
        [carrier],
        makeInput(),
        new TraceBuilder(),
        new Map([['risk', { rule: carrier, value: 'low', declaration: RISK }]]),
      );
      expect(result.outputs['value']).toEqual({
        name: 'value',
        type: 'number',
        combine: 'sum',
        value: 10,
        contributors: ['C'],
      });
      expect(result.outputs['risk']?.contributors).toEqual(['C']);
      expect(result.applied).toEqual([carrier]);
      expect(result.breakdown.map((b) => [b.ruleId, b.output])).toEqual([
        ['C', 'risk'],
        ['C', 'value'],
      ]);
    });

    it('skips another rule left feeding a short-circuited output with SHORT_CIRCUITED', () => {
      const pipeline = pipelineWith(new StubModel('M', 10));
      const carrier = makeRule({
        id: 'X',
        model: EXCEPTION_MODEL,
        exceptions: [{ kind: 'shortCircuit', output: 'value', value: 5 }],
      });
      const stray = makeRule({ id: 's', model: 'M' });
      const result = pipeline.execute(
        [stray],
        makeInput(),
        new TraceBuilder(),
        new Map([
          ['value', { rule: carrier, value: 5, declaration: { type: 'number', combine: 'sum' } }],
        ]),
      );
      expect(result.skipped).toEqual([
        { rule: stray, reason: 'SHORT_CIRCUITED', detail: 'output value short-circuited by X@1' },
      ]);
      expect(result.outputs['value']).toEqual({
        name: 'value',
        type: 'number',
        combine: 'sum',
        value: 5,
        contributors: ['X'],
      });
    });
  });

  describe('behaviour changes on legacy number models', () => {
    it('excludes NaN, Infinity, a string and a wrapped string with OUTPUT_MISMATCH', () => {
      const cases: { value: OutputValue | CalculationOutput<OutputValue>; detail: string }[] = [
        { value: NaN, detail: 'output value: the value is not JSON at $ (NaN)' },
        { value: Infinity, detail: 'output value: the value is not JSON at $ (Infinity)' },
        { value: '100', detail: 'output value: value "100" does not match type number' },
        { value: { value: '5' }, detail: 'output value: value "5" does not match type number' },
      ];
      for (const { value, detail } of cases) {
        const pipeline = pipelineWith(
          new ValueModel('X', undefined, { x: value }),
          new StubModel('Y', 2),
        );
        const x = makeRule({ id: 'x', model: 'X' });
        const result = pipeline.execute(
          [x, makeRule({ id: 'y', model: 'Y' })],
          makeInput(),
          new TraceBuilder(),
          NONE,
        );
        expect(result.skipped).toEqual([{ rule: x, reason: 'OUTPUT_MISMATCH', detail }]);
        expect(result.outputs.value.value).toBe(2);
      }
    });

    it('names the path of a nested value that is not JSON', () => {
      const object: OutputDeclaration = { type: 'object', combine: 'highestPriority' };
      const pipeline = pipelineWith(new ValueModel('O', object, { a: { a: { b: [1] } } }));
      // A JavaScript model can return undefined deep inside; typed code cannot.
      const nested: OutputValue = Object.assign(Object.create(null), {
        a: { b: [1, undefined] },
      });
      const holey = pipelineWith(new ValueModel('O', object, { a: nested }));
      const rule = makeRule({ id: 'a', model: 'O', output: 'o' });
      expect(pipeline.execute([rule], makeInput(), new TraceBuilder(), NONE).skipped).toEqual([]);
      expect(holey.execute([rule], makeInput(), new TraceBuilder(), NONE).skipped).toEqual([
        {
          rule,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output o: the value is not JSON at $.a.b[1] (undefined)',
        },
      ]);
    });
  });

  it('excludes, without computing it, a rule feeding value with a declaration other than number', () => {
    const flag = new ValueModel('FLAG', { type: 'boolean', combine: 'all' }, { a: true, b: true });
    const pipeline = pipelineWith(flag, new StubModel('M', 3));
    const a = makeRule({ id: 'a', model: 'FLAG' });
    const result = pipeline.execute(
      [a, makeRule({ id: 'b', model: 'FLAG', output: 'ok' }), makeRule({ id: 'm', model: 'M' })],
      makeInput(),
      new TraceBuilder(),
      NONE,
    );
    expect(result.skipped).toEqual([
      {
        rule: a,
        reason: 'OUTPUT_MISMATCH',
        detail: 'output value must be a number: a@1 declares it boolean/all',
      },
    ]);
    expect(result.outputs.value.value).toBe(3);
    expect(result.outputs['ok']?.value).toBe(true);
    expect(flag.calls).toBe(1);
  });

  it('throws OutputNotFiniteError when a sum overflows', () => {
    const pipeline = pipelineWith(new StubModel('H', 1e308));
    try {
      pipeline.execute(
        [makeRule({ id: 'b', model: 'H' }), makeRule({ id: 'a', model: 'H', priority: 900 })],
        makeInput(),
        new TraceBuilder(),
        NONE,
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      if (!(e instanceof OutputNotFiniteError)) throw e;
      expect(e.output).toBe('value');
      expect(e.contributors).toEqual(['a', 'b']);
    }
  });

  describe('decimals and rounding', () => {
    const TAX: OutputDeclaration = {
      type: 'decimal',
      combine: 'sum',
      rounding: { scale: 2, mode: 'halfUp', at: 'contribution' },
    };

    it('records canonical, rounded contributions and unrounded only when rounding changed them', () => {
      const pipeline = pipelineWith(
        new ValueModel('TAX', TAX, { a: '1.005', b: { value: '0002.50', detail: 'flat' } }),
      );
      const trace = new TraceBuilder();
      const result = pipeline.execute(
        [
          makeRule({ id: 'a', model: 'TAX', output: 'tax', priority: 200 }),
          makeRule({ id: 'b', model: 'TAX', output: 'tax' }),
        ],
        makeInput(),
        trace,
        NONE,
      );
      expect(result.outputs['tax']).toEqual({
        name: 'tax',
        type: 'decimal',
        combine: 'sum',
        value: '3.51',
        contributors: ['a', 'b'],
      });
      expect(result.breakdown).toStrictEqual([
        {
          ruleId: 'a',
          ruleVersion: 1,
          output: 'tax',
          contribution: '1.01',
          unrounded: '1.005',
          modelUsed: 'TAX',
          detail: undefined,
        },
        {
          ruleId: 'b',
          ruleVersion: 1,
          output: 'tax',
          contribution: '2.5',
          modelUsed: 'TAX',
          detail: 'flat',
        },
      ]);
      const steps = trace.build().steps;
      expect(steps.map((s) => [s.ruleId, s.contribution, s.unrounded])).toEqual([
        ['a', '1.01', '1.005'],
        ['b', '2.5', undefined],
      ]);
      expect(steps.map((s) => Object.hasOwn(s, 'unrounded'))).toEqual([true, false]);
    });

    it("rounds the combined value only at 'output', recording no unrounded", () => {
      const pipeline = pipelineWith(
        new ValueModel(
          'TAX',
          { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'halfUp' } },
          { a: '1.005', b: '1.005' },
        ),
      );
      const result = pipeline.execute(
        [
          makeRule({ id: 'a', model: 'TAX', output: 'tax' }),
          makeRule({ id: 'b', model: 'TAX', output: 'tax' }),
        ],
        makeInput(),
        new TraceBuilder(),
        NONE,
      );
      expect(result.outputs['tax']?.value).toBe('2.01');
      expect(result.breakdown.map((b) => [b.contribution, Object.hasOwn(b, 'unrounded')])).toEqual([
        ['1.005', false],
        ['1.005', false],
      ]);
    });

    it('excludes rules declaring different roundings for one output, without computing them', () => {
      const two = new ValueModel(
        'TWO',
        { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'halfUp' } },
        { a: '1' },
      );
      const zero = new ValueModel(
        'ZERO',
        {
          type: 'decimal',
          combine: 'sum',
          rounding: { scale: 0, mode: 'floor', at: 'contribution' },
        },
        { b: '1' },
      );
      const result = pipelineWith(two, zero).execute(
        [
          makeRule({ id: 'a', model: 'TWO', output: 'tax' }),
          makeRule({ id: 'b', model: 'ZERO', output: 'tax' }),
        ],
        makeInput(),
        new TraceBuilder(),
        NONE,
      );
      const detail =
        'rules feeding output tax declare it differently: ' +
        'a@1 decimal/sum rounding 2 halfUp; b@1 decimal/sum rounding 0 floor at contribution';
      expect(result.skipped.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
        ['a', 'OUTPUT_MISMATCH', detail],
        ['b', 'OUTPUT_MISMATCH', detail],
      ]);
      expect(result.outputs['tax']).toBeUndefined();
      expect([two.calls, zero.calls]).toEqual([0, 0]);
    });

    it("treats rounding.at 'output' and an absent at as the same declaration", () => {
      const absent = new ValueModel(
        'ABSENT',
        { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'halfUp' } },
        { a: '1.005' },
      );
      const output = new ValueModel(
        'OUTPUT',
        { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'halfUp', at: 'output' } },
        { b: '1.005' },
      );
      const result = pipelineWith(absent, output).execute(
        [
          makeRule({ id: 'a', model: 'ABSENT', output: 'tax' }),
          makeRule({ id: 'b', model: 'OUTPUT', output: 'tax' }),
        ],
        makeInput(),
        new TraceBuilder(),
        NONE,
      );
      expect(result.skipped).toEqual([]);
      expect(result.outputs['tax']?.value).toBe('2.01');
    });

    it('excludes a rule feeding value with a decimal declaration', () => {
      const amount = new ValueModel('AMOUNT', { type: 'decimal', combine: 'sum' }, { a: '1' });
      const a = makeRule({ id: 'a', model: 'AMOUNT' });
      const result = pipelineWith(amount).execute([a], makeInput(), new TraceBuilder(), NONE);
      expect(result.skipped).toEqual([
        {
          rule: a,
          reason: 'OUTPUT_MISMATCH',
          detail: 'output value must be a number: a@1 declares it decimal/sum',
        },
      ]);
      expect(result.outputs.value.value).toBe(0);
      expect(amount.calls).toBe(0);
    });

    it('throws DecimalPrecisionError when an exact sum exceeds a span of 1000 digits', () => {
      const pipeline = pipelineWith(
        new ValueModel(
          'BIG',
          { type: 'decimal', combine: 'sum' },
          { a: `1${'0'.repeat(999)}`, b: '0.1' },
        ),
      );
      try {
        pipeline.execute(
          [
            makeRule({ id: 'a', model: 'BIG', output: 'amount' }),
            makeRule({ id: 'b', model: 'BIG', output: 'amount' }),
          ],
          makeInput(),
          new TraceBuilder(),
          NONE,
        );
        expect.unreachable('should have thrown');
      } catch (e) {
        if (!(e instanceof DecimalPrecisionError)) throw e;
        expect([e.code, e.output, e.limit]).toEqual(['DECIMAL_PRECISION', 'amount', 1000]);
      }
    });
  });

  describe('short-circuits on rounded outputs (R38, R39)', () => {
    const carrier = makeRule({
      id: 'X',
      model: EXCEPTION_MODEL,
      priority: 9000,
      exceptions: [{ kind: 'shortCircuit', output: 'amount', value: '0001.005' }],
    });
    const imposing = (declaration: OutputDeclaration, value: JsonValue) =>
      pipelineWith().execute(
        [],
        makeInput(),
        new TraceBuilder(),
        new Map<string, ShortCircuit>([['amount', { rule: carrier, value, declaration }]]),
      );

    it("normalizes and rounds the imposed value at 'output', recording it unrounded in the step", () => {
      const result = imposing(
        { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'halfUp' } },
        '0001.005',
      );
      expect(result.outputs['amount']).toEqual({
        name: 'amount',
        type: 'decimal',
        combine: 'sum',
        value: '1.01',
        contributors: ['X'],
      });
      expect(result.breakdown).toStrictEqual([
        {
          ruleId: 'X',
          ruleVersion: 1,
          output: 'amount',
          contribution: '1.005',
          modelUsed: EXCEPTION_MODEL,
          detail: { shortCircuit: null },
        },
      ]);
    });

    it("rounds the imposed value as the only contribution at 'contribution'", () => {
      const trace = new TraceBuilder();
      const result = pipelineWith().execute(
        [],
        makeInput(),
        trace,
        new Map<string, ShortCircuit>([
          [
            'amount',
            {
              rule: carrier,
              value: '0001.005',
              declaration: {
                type: 'decimal',
                combine: 'sum',
                rounding: { scale: 2, mode: 'halfUp', at: 'contribution' },
              },
            },
          ],
        ]),
      );
      expect(result.outputs['amount']?.value).toBe('1.01');
      expect(result.breakdown.map((b) => [b.contribution, b.unrounded])).toEqual([
        ['1.01', '1.005'],
      ]);
      expect(trace.build().steps.map((s) => [s.contribution, s.unrounded])).toEqual([
        ['1.01', '1.005'],
      ]);
    });

    it('rounds an imposed number', () => {
      const result = imposing(
        { type: 'number', combine: 'max', rounding: { scale: 1, mode: 'ceiling' } },
        2.71,
      );
      expect(result.outputs['amount']?.value).toBe(2.8);
    });

    it('throws DecimalPrecisionError on an imposed decimal beyond a span of 1000 digits', () => {
      expect(() =>
        imposing({ type: 'decimal', combine: 'highestPriority' }, `1${'0'.repeat(999)}.1`),
      ).toThrow(DecimalPrecisionError);
    });
  });
});
