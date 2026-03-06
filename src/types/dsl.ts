export interface DSLEvaluator {
  readonly dsl: string;
  readonly version: string;

  evaluate(expression: unknown, context: Record<string, unknown>): boolean;
}
