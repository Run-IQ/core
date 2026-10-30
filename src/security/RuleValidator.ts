import { SpecError, verifyRuleChecksum } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import { ValidationError } from '../errors/ValidationError.js';

export interface RuleValidationResult {
  readonly valid: readonly Rule[];
  readonly invalid: readonly SkippedRule[];
}

/**
 * Checks each rule's integrity (`verifyRuleChecksum` of `@run-iq/spec`) and its params.
 *
 * - checksum mismatch: `CHECKSUM_MISMATCH`;
 * - malformed rule, whose checksum cannot be computed (`SpecError`, e.g. an invalid date or a
 *   non-integer version): `INVALID_RULE`, with the `SpecError` message as `detail`;
 * - params refused by a registered model: `INVALID_PARAMS`.
 *
 * With `onChecksumMismatch: 'throw'`, the first two throw instead of skipping the rule.
 */
export class RuleValidator {
  constructor(
    private readonly modelRegistry: ModelRegistry,
    private readonly onChecksumMismatch: 'throw' | 'skip' = 'skip',
  ) {}

  validate(rules: ReadonlyArray<Rule>): RuleValidationResult {
    const valid: Rule[] = [];
    const invalid: SkippedRule[] = [];

    for (const rule of rules) {
      const skipped = this.checkRule(rule);
      if (skipped) {
        invalid.push(skipped);
      } else {
        valid.push(rule);
      }
    }

    return { valid, invalid };
  }

  private checkRule(rule: Rule): SkippedRule | null {
    // 1. Verify checksum (full rule integrity)
    let intact: boolean;
    try {
      intact = verifyRuleChecksum(rule);
    } catch (error) {
      if (!(error instanceof SpecError)) throw error;
      const detail = `Invalid rule ${String(rule.id)}: ${error.message}`;
      if (this.onChecksumMismatch === 'throw') {
        throw new ValidationError(detail, [detail]);
      }
      return { rule, reason: 'INVALID_RULE', detail };
    }

    if (!intact) {
      if (this.onChecksumMismatch === 'throw') {
        throw new Error(`Checksum mismatch for rule ${rule.id}`);
      }
      return { rule, reason: 'CHECKSUM_MISMATCH' };
    }

    // 2. Validate params via model (if registered)
    // Note: unregistered models are allowed here — plugins may handle them
    // in beforeEvaluate (e.g., meta-rules). ExecutionPipeline will skip them.
    if (this.modelRegistry.has(rule.model)) {
      const model = this.modelRegistry.get(rule.model);
      const validation = model.validateParams(rule.params);
      if (!validation.valid) {
        return { rule, reason: 'INVALID_PARAMS' };
      }
    }

    return null;
  }
}
