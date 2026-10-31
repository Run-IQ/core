import { describe, it, expect } from 'vitest';
import { EXCEPTION_MODEL } from '@run-iq/spec';
import type { OutputDeclaration } from '@run-iq/spec';
import { ExecutionPipeline } from '../../src/engine/ExecutionPipeline.js';
import type { ShortCircuit } from '../../src/engine/ExceptionProcessor.js';
import { TraceBuilder } from '../../src/engine/TraceBuilder.js';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import type { CalculationModel } from '../../src/types/model.js';
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
  return new ExecutionPipeline(registry, 'throw');
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
      { ruleId: 'r1', output: 'value', contribution: 50, modelUsed: 'M', detail: undefined },
      { ruleId: 'r2', output: 'risk', contribution: 'high', modelUsed: 'RISK', detail: 'scored' },
    ]);
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
        { rule: a, reason: 'OUTPUT_MISMATCH', detail: 'output terms: the value is not JSON' },
        { rule: n, reason: 'OUTPUT_MISMATCH', detail: 'output value: the value is not JSON' },
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
          output: 'risk',
          contribution: 'high',
          modelUsed: EXCEPTION_MODEL,
          detail: { shortCircuit: 'blacklisted' },
        },
        { ruleId: 'v', output: 'value', contribution: 10, modelUsed: 'M', detail: undefined },
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
});
