import { describe, it, expect } from 'vitest';
import { ExecutionPipeline } from '../../src/engine/ExecutionPipeline.js';
import { TraceBuilder } from '../../src/engine/TraceBuilder.js';
import { ModelRegistry } from '../../src/registry/ModelRegistry.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

describe('ExecutionPipeline', () => {
  it('executes rules and aggregates contributions', () => {
    const registry = new ModelRegistry();
    registry.register(new StubModel('M1', 100));
    registry.register(new StubModel('M2', 200));

    const pipeline = new ExecutionPipeline(registry);
    const traceBuilder = new TraceBuilder();

    const rules = [makeRule({ id: 'r1', model: 'M1' }), makeRule({ id: 'r2', model: 'M2' })];

    const result = pipeline.execute(rules, makeInput(), traceBuilder);
    expect(result.value).toBe(300);
    expect(result.breakdown).toHaveLength(2);
    expect(result.appliedRules).toHaveLength(2);
  });

  it('builds trace with one step per rule', () => {
    const registry = new ModelRegistry();
    registry.register(new StubModel('M', 50));

    const pipeline = new ExecutionPipeline(registry);
    const traceBuilder = new TraceBuilder();

    const rules = [makeRule({ id: 'r1', model: 'M' })];
    pipeline.execute(rules, makeInput(), traceBuilder);

    const trace = traceBuilder.build();
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]!.ruleId).toBe('r1');
    expect(trace.steps[0]!.modelUsed).toBe('M');
    expect(trace.steps[0]!.contribution).toBe(50);
  });

  it('handles empty rules', () => {
    const registry = new ModelRegistry();
    const pipeline = new ExecutionPipeline(registry);
    const traceBuilder = new TraceBuilder();

    const result = pipeline.execute([], makeInput(), traceBuilder);
    expect(result.value).toBe(0);
    expect(result.breakdown).toHaveLength(0);
  });
});
