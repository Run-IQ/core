import { SpecError, toExecutableRule, validateRuleDefinition } from '@run-iq/spec';
import type { RuleDefinitionInput } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import { ValidationError } from '../errors/ValidationError.js';

/**
 * Builds a `Rule` from raw data (JSON from a database or an API) with `toExecutableRule` of
 * `@run-iq/spec`: dates become `Date`, defaults are explicit (`dimensions: {}`, `tags: []`),
 * tags are sorted. The stored `checksum` is KEPT, not recomputed, so the engine still detects
 * a row modified after sealing (`CHECKSUM_MISMATCH`).
 *
 * Throws `ValidationError` when a required field is mistyped or the rule is not a valid
 * definition; then `reasons` lists every problem found by `validateRuleDefinition`.
 */
export function hydrateRule(raw: Record<string, unknown>): Rule {
  if (typeof raw.id !== 'string') {
    throw new ValidationError('rule.id must be a string', ['rule.id must be a string']);
  }
  if (typeof raw.model !== 'string') {
    throw new ValidationError('rule.model must be a string', ['rule.model must be a string']);
  }
  if (typeof raw.priority !== 'number') {
    throw new ValidationError('rule.priority must be a number', ['rule.priority must be a number']);
  }
  if (typeof raw.version !== 'number') {
    throw new ValidationError('rule.version must be a number', ['rule.version must be a number']);
  }
  if (typeof raw.checksum !== 'string') {
    throw new ValidationError('rule.checksum must be a string', ['rule.checksum must be a string']);
  }

  let rule: Rule;
  try {
    // justification: required fields are type-checked above; toExecutableRule validates the rest
    rule = toExecutableRule(raw as unknown as RuleDefinitionInput);
  } catch (error) {
    if (error instanceof SpecError) {
      // Report every problem of the rule, not only the first one normalization hit.
      const { errors } = validateRuleDefinition(raw);
      const reasons = errors.length > 0 ? errors : [error.message];
      throw new ValidationError(
        `Invalid rule ${raw.id}@${raw.version}: ${reasons.join('; ')}`,
        reasons,
      );
    }
    throw error;
  }
  return { ...rule, checksum: raw.checksum };
}

export function hydrateRules(rawRules: Record<string, unknown>[]): Rule[] {
  return rawRules.map(hydrateRule);
}
