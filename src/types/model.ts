import type { JsonPointer, OutputDeclaration } from '@run-iq/spec';
import type { Rule } from './rule.js';
import type { OutputValue } from './output.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly string[] | undefined;
}

/**
 * A computed value with an optional explanation, kept in the breakdown and the trace. The engine
 * reads a plain object with an own `value` as a `CalculationOutput`; for an `object` output, only
 * when `value` and `detail` are its only keys (return `{ value: { value: 1 } }` for the object
 * `{ value: 1 }`).
 */
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

  /**
   * Computes the rule's contribution. The arguments are frozen views: `input` is the evaluation's
   * own frozen data, `rule` and its `params` are a fresh frozen copy of the rule (with its own
   * `Date`s). A model that writes into them (strict mode throws) does not fail the evaluation: its
   * rule is excluded with the reason `MODEL_ERROR` and the detail `wrote to its input: ...`.
   * Any other throw is the model's and fails the evaluation.
   */
  calculate(
    input: Record<string, unknown>,
    matchedRule: Readonly<Rule>,
    params: unknown,
  ): V | CalculationOutput<V>;

  describeParams?(): Record<string, ParamDescriptor>;

  /**
   * The JSON pointers, into the evaluation context, of the facts the model reads for these
   * `params` (`/revenue/total`; D-1), joined with those of the rule's condition by `readsOf`. A
   * model that returns anything else, or throws, has its rule's reads treated as unknown (D-39);
   * a model without it declares nothing.
   */
  listVariables?(params: unknown): JsonPointer[];
}
