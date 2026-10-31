export interface TraceStep {
  readonly ruleId: string;
  readonly ruleVersion: number;
  /** The output the rule contributed to. */
  readonly output: string;
  /** The rule's reference to its legal or business source, when it has one. */
  readonly sourceRef?: string | undefined;
  readonly conditionResult: boolean;
  readonly conditionDetail: unknown;
  readonly modelUsed: string;
  readonly inputSnapshot: unknown;
  readonly contribution: unknown;
  readonly detail?: unknown;
  readonly durationMs: number;
  readonly dslUsed?: string | undefined;
}

export interface EvaluationTrace {
  readonly steps: readonly TraceStep[];
  readonly totalDurationMs: number;
}
