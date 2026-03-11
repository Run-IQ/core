import type { Rule } from './rule.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly string[] | undefined;
}

export interface CalculationOutput {
  readonly value: number;
  readonly detail?: unknown;
}

export interface ParamDescriptor {
  readonly type: string;
  readonly description?: string | undefined;
}

export interface CalculationModel {
  readonly name: string;
  readonly version: string;

  validateParams(params: unknown): ValidationResult;

  calculate(
    input: Record<string, unknown>,
    matchedRule: Readonly<Rule>,
    params: unknown,
  ): number | CalculationOutput;

  describeParams?(): Record<string, ParamDescriptor>;
}
