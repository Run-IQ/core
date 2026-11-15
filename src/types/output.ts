import type { CombineStrategy, JsonValue, OutputStatus, OutputType } from '@run-iq/spec';

/** A value a model computes for an output: any JSON value (a number for the default output). */
export type OutputValue = JsonValue;

/**
 * One output of a decision, combined from the contributions of the applied rules.
 * Rules without `output` feed the default output `value` (`number`, combined by `sum`).
 */
export interface DecisionOutput {
  readonly name: string;
  /** Declared by the models that feed the output (`DEFAULT_OUTPUT_DECLARATION` when none). */
  readonly type: OutputType;
  readonly combine: CombineStrategy;
  /**
   * `determined`: `value` is the combination of the applied rules and `pending` is empty.
   * `undetermined`: at least one pending rule feeds the output, and `value` is absent (never `null`,
   * never `undefined` as a member). 9M1 writes these two; the other members of spec's
   * `OutputStatus` come with 9O.
   */
  readonly status: OutputStatus;
  /** Absent when the output is undetermined (R6: no `value` key at all). */
  readonly value?: JsonValue;
  /**
   * Ids of the rules whose contribution entered `value`, by priority descending then id: for
   * `highestPriority`, only those of the highest priority; for a short-circuited output, only
   * the rule carrying the short-circuit.
   */
  readonly contributors: readonly string[]; /**
   * Ids of the pending rules that feed the output, each once, in contribution order (priority
   * descending, then `id@version`); `[]` when the output is determined.
   */
  readonly pending: readonly string[];
}
