import type { CombineStrategy, JsonValue, OutputType } from '@run-iq/spec';

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
  readonly value: JsonValue;
  /** Ids of the rules whose contribution entered `value`. */
  readonly contributors: readonly string[];
}
