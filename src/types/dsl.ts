export interface DSLOperatorDoc {
  readonly name: string;
  readonly description: string;
  readonly syntax: string;
}

export interface DSLExampleDoc {
  readonly description: string;
  readonly expression: unknown;
}

export interface DSLSyntaxDoc {
  readonly description: string;
  readonly conditionFormat: string;
  readonly operators: readonly DSLOperatorDoc[];
  readonly examples: readonly DSLExampleDoc[];
}

export interface DSLEvaluator {
  readonly dsl: string;
  readonly version: string;

  evaluate(expression: unknown, context: Record<string, unknown>): boolean;

  describeSyntax?(): DSLSyntaxDoc;
}
