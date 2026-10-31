import type { OutputDeclaration } from '@run-iq/spec';
import type { Rule } from './rule.js';
import type { OutputValue } from './output.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly string[] | undefined;
}

/** A computed value with an optional explanation, kept in the breakdown and the trace. */
export interface CalculationOutput<V extends OutputValue = number> {
  readonly value: V;
  readonly detail?: unknown;
}

export interface ParamDescriptor {
  readonly type: string;
  readonly description?: string | undefined;
}

/**
 * A calculation model. `V` is the type of the value it computes: `number` by default, so that
 * models written before typed outputs keep compiling unchanged.
 */
export interface CalculationModel<V extends OutputValue = number> {
  readonly name: string;
  readonly version: string;
  /**
   * The output the model feeds: its type and how contributions combine. Absent means
   * `DEFAULT_OUTPUT_DECLARATION` of `@run-iq/spec` (`number`, `sum`). The output's name is the
   * rule's `output` (`'value'` when absent).
   */
  readonly output?: OutputDeclaration | undefined;

  validateParams(params: unknown): ValidationResult;

  calculate(
    input: Record<string, unknown>,
    matchedRule: Readonly<Rule>,
    params: unknown,
  ): V | CalculationOutput<V>;

  describeParams?(): Record<string, ParamDescriptor>;
}
