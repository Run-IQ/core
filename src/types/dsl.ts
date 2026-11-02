import type { JsonPointer, JsonValue } from '@run-iq/spec';

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

/** What a DSL can promise about the way it computes. */
export interface DSLCapabilities {
  /** Decimals are computed exactly (no binary floating point). */
  readonly exactDecimals: boolean;
  /** The DSL can answer `unknown` for a condition that reads an absent fact. */
  readonly threeValued?: boolean | undefined;
}

export interface DSLEvaluator {
  readonly dsl: string;
  readonly version: string;

  evaluate(expression: unknown, context: Record<string, unknown>): boolean;

  /**
   * The JSON pointers, into the evaluation context, of the facts the expression reads
   * (`/revenue/total`, `/$outputs/risk`, `/$dates/effective`, `/$dimensions/country`; D-1). The
   * engine reports those absent from `input.data` in `EvaluationResult.missingFacts`. A DSL that
   * returns anything else (a dotted path, a throw) has its rule's reads treated as unknown
   * (`readsOf`, D-39); a DSL without it declares nothing.
   */
  listVariables?(expression: unknown): JsonPointer[];

  /**
   * Computes a value from an expression and the evaluation context (shape only in 9L: nothing
   * calls it yet).
   */
  compute?(expression: unknown, context: Record<string, unknown>): JsonValue;

  /** What the DSL promises (shape only in 9L). */
  readonly capabilities?: DSLCapabilities | undefined;

  describeSyntax?(): DSLSyntaxDoc;
}
