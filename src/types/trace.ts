export interface TraceStep {
  readonly ruleId: string;
  readonly conditionResult: boolean;
  readonly conditionDetail: unknown;
  readonly modelUsed: string;
  readonly inputSnapshot: unknown;
  readonly contribution: unknown;
  readonly durationMs: number;
  readonly dslUsed?: string | undefined;
}

export interface EvaluationTrace {
  readonly steps: readonly TraceStep[];
  readonly totalDurationMs: number;
}
