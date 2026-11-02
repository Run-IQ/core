import {
  DEFAULT_OUTPUT,
  DEFAULT_OUTPUT_DECLARATION,
  canonicalize,
  contributionMatchesDeclaration,
  normalizeOutputDeclaration,
  valueMatchesOutputType,
} from '@run-iq/spec';
import type { JsonValue, OutputDeclaration } from '@run-iq/spec';
import { describeValue } from '../utils/json.js';
import { readDecimal } from './decimalArithmetic.js';
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
 * What two declarations are compared by: the canonical text of their normal form in
 * `@run-iq/spec` (`normalizeOutputDeclaration`), so the order of enum `values` is part of the
 * declaration, while `rounding.at: 'output'`, `empty: false` and an increment that is a power of
 * ten (written as its `scale`) are the same declaration as their one written form.
 */
export function declarationKey(declaration: OutputDeclaration): string {
  return canonicalize(normalizeOutputDeclaration(declaration));
}

/** The type of a declaration, for messages: `number`, `enum (low, high)`. */
export function describeType(declaration: OutputDeclaration): string {
  return declaration.values === undefined
    ? declaration.type
    : `${declaration.type} (${declaration.values.join(', ')})`;
}

/**
 * The value a contribution or a short-circuit value enters an output with, before any rounding:
 * for a `decimal` output, the canonical form of a decimal string or a safe integer
 * (`readDecimal`); for another type, the value itself when it matches it. `undefined` when the
 * declaration refuses the value.
 */
export function readOutputValue(
  value: JsonValue,
  declaration: OutputDeclaration,
): JsonValue | undefined {
  if (declaration.type === 'decimal') return readDecimal(value);
  return valueMatchesOutputType(value, declaration) ? value : undefined;
}

/**
 * The value one rule's contribution enters an output with: `readOutputValue`, except that a
 * `count` takes a boolean (the contributions that are `true` are counted) and keeps it as it is.
 * `undefined` when the declaration refuses the value.
 */
export function readContribution(
  value: JsonValue,
  declaration: OutputDeclaration,
): JsonValue | undefined {
  if (declaration.combine !== 'count') return readOutputValue(value, declaration);
  return contributionMatchesDeclaration(value, declaration) ? value : undefined;
}

/** What a `decimal` value may be, for messages. */
const DECIMAL_EXPECTED =
  'expected a decimal string (an optional "-", digits, an optional "." and digits, no exponent) ' +
  'or a safe integer';

/**
 * Why `readOutputValue` refuses a value, for messages: `value "x" does not match type number`,
 * with what a decimal may be for a `decimal` output.
 */
export function describeMismatch(
  value: unknown,
  declaration: OutputDeclaration,
  contribution = false,
): string {
  let expected = declaration.type === 'decimal' ? `: ${DECIMAL_EXPECTED}` : '';
  if (contribution && declaration.combine === 'count') {
    expected = ': a count takes a boolean (true is counted)';
  }
  return `value ${describeValue(value)} does not match type ${describeType(declaration)}${expected}`;
}

/**
 * A whole declaration, for messages: `number/sum`, `enum/highestPriority (low, high)`,
 * `decimal/sum rounding 2 halfUp at contribution` (`at` shown only when declared).
 */
export function describeDeclaration(declaration: OutputDeclaration): string {
  const { values, rounding } = declaration;
  const listed = values === undefined ? '' : ` (${values.join(', ')})`;
  const step =
    rounding?.increment === undefined ? rounding?.scale : `increment ${rounding.increment}`;
  const rounded =
    rounding === undefined
      ? ''
      : ` rounding ${step} ${rounding.mode}${rounding.at === undefined ? '' : ` at ${rounding.at}`}`;
  return `${declaration.type}/${declaration.combine}${listed}${rounded}`;
}

/**
 * True when `declaration` may not be that of output `name`: the default output `value` is a
 * number (`result.value` stays one), whatever its combine strategy.
 */
export const refusesDeclaration = (name: string, declaration: OutputDeclaration): boolean =>
  name === DEFAULT_OUTPUT && declaration.type !== 'number';
