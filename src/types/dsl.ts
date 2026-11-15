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

  /**
   * Decides whether the condition holds. Synchronous: a promise it returns is a breach (the rule
   * is excluded with `DSL_ERROR`, `returned a promise`), never awaited, and `timeout.dsl` is
   * inert in 9L, so a slow DSL blocks the evaluation. `expression` and `context` are write-trapping
   * views of the engine's own data, never the caller's objects; every date in them is a string, never
   * a `Date`. A refused write taints the call: even when the DSL catches the error and answers,
   * the rule is excluded with `DSL_ERROR`. What it returns is read once, bounded, and weighed.
   */
  evaluate(expression: unknown, context: Record<string, unknown>): boolean;

  /**
   * The JSON pointers, into the evaluation context, of the facts the expression reads
   * (`/revenue/total`, `/$outputs/risk`, `/$dates/effective`, `/$dimensions/country`; D-1). The
   * engine reports in `EvaluationResult.missingFacts` the pointers of the conditions that are
   * absent from the context: facts of `data`, `/$dates/...` and `/$dimensions/...` (the other
   * engine variables are not built yet), and not yet what a model's `listVariables` names. A DSL that
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
