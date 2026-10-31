import { DEFAULT_OUTPUT, DEFAULT_OUTPUT_DECLARATION, canonicalize } from '@run-iq/spec';
import type { OutputDeclaration } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';

/** The output a rule feeds: its `output`, or `DEFAULT_OUTPUT` (`value`). */
export const outputOf = (rule: Rule): string => rule.output ?? DEFAULT_OUTPUT;

/**
 * The declaration of the output a rule feeds: its model's `output`, or
 * `DEFAULT_OUTPUT_DECLARATION` (`number`, `sum`). Throws `ModelNotFoundError` for an unregistered
 * model.
 */
export function declarationOf(models: ModelRegistry, rule: Rule): OutputDeclaration {
  return models.get(rule.model).output ?? DEFAULT_OUTPUT_DECLARATION;
}

/**
 * What two declarations are compared by: their canonical form as it is, so the order of enum
 * `values` is part of the declaration.
 */
export const declarationKey = (declaration: OutputDeclaration): string => canonicalize(declaration);

/** The type of a declaration, for messages: `number`, `enum (low, high)`. */
export function describeType(declaration: OutputDeclaration): string {
  return declaration.values === undefined
    ? declaration.type
    : `${declaration.type} (${declaration.values.join(', ')})`;
}

/**
 * A whole declaration, for messages: `number/sum`, `enum/highestPriority (low, high)`,
 * `decimal/sum rounding 2 halfUp at contribution` (`at` shown only when declared).
 */
export function describeDeclaration(declaration: OutputDeclaration): string {
  const { values, rounding } = declaration;
  const listed = values === undefined ? '' : ` (${values.join(', ')})`;
  const rounded =
    rounding === undefined
      ? ''
      : ` rounding ${rounding.scale} ${rounding.mode}${rounding.at === undefined ? '' : ` at ${rounding.at}`}`;
  return `${declaration.type}/${declaration.combine}${listed}${rounded}`;
}

/**
 * True when `declaration` may not be that of output `name`: the default output `value` is a
 * number (`result.value` stays one), whatever its combine strategy.
 */
export const refusesDeclaration = (name: string, declaration: OutputDeclaration): boolean =>
  name === DEFAULT_OUTPUT && declaration.type !== 'number';
