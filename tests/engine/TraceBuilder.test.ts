import { describe, it, expect } from 'vitest';
import { TraceBuilder } from '../../src/engine/TraceBuilder.js';

describe('TraceBuilder', () => {
  it('builds a trace with steps', () => {
    const builder = new TraceBuilder();
    builder.addStep({
      ruleId: 'r1',
      conditionResult: true,
      conditionDetail: null,
      modelUsed: 'FLAT_RATE',
      inputSnapshot: { amount: 1000 },
      contribution: 180,
      durationMs: 1.5,
      dslUsed: 'jsonlogic',
    });

    const trace = builder.build();
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]!.ruleId).toBe('r1');
    expect(trace.steps[0]!.dslUsed).toBe('jsonlogic');
    expect(trace.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('tracks total duration', () => {
    const builder = new TraceBuilder();
    const trace = builder.build();
    expect(typeof trace.totalDurationMs).toBe('number');
    expect(trace.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
