import { createHash } from 'node:crypto';
import { canonicalize, computeRuleChecksum as specRuleChecksum } from '@run-iq/spec';
import type { RuleDefinitionInput } from '@run-iq/spec';

/**
 * sha256 hex of `canonicalize(params)` from `@run-iq/spec`. Throws `SpecError` on a value that
 * has no canonical JSON form (`undefined`, `NaN`, `Infinity`, `Map`...).
 */
export function hashParams(params: unknown): string {
  return createHash('sha256').update(canonicalize(params)).digest('hex');
}

/**
 * Checksum of a rule: `computeRuleChecksum` of `@run-iq/spec`, i.e. sha256 of the canonical
 * form of the normalized definition. Dates are normalized first (`Date`, `YYYY-MM-DD` and an
 * ISO date-time with a zone give the same checksum), tags are sorted and deduplicated, a
 * top-level `null` counts as absent, and the `checksum` field itself is ignored. Every other
 * field, plugin extensions included, enters the hash.
 *
 * Throws `SpecError` when the rule is not a valid definition (missing or invalid
 * `effectiveFrom`, non-integer `version`, empty validity window, non-JSON value...).
 */
export function computeRuleChecksum(rule: object): string {
  return specRuleChecksum(rule as RuleDefinitionInput);
}
