import type { EvaluationTrace, TraceStep } from '../types/trace.js';

export class TraceBuilder {
  private readonly steps: TraceStep[] = [];
  private readonly startTime: number;

  constructor() {
    this.startTime = performance.now();
  }

  addStep(step: TraceStep): void {
    this.steps.push(step);
  }

  build(): EvaluationTrace {
    return {
      steps: [...this.steps],
      totalDurationMs: Math.round((performance.now() - this.startTime) * 100) / 100,
    };
  }
}
