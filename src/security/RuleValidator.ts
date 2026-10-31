import { EXCEPTION_MODEL, SpecError, verifyRuleChecksum } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import { ValidationError } from '../errors/ValidationError.js';
import { ruleLabel } from '../utils/values.js';

export interface RuleValidationResult {
  readonly valid: readonly Rule[];
  readonly invalid: readonly SkippedRule[];
}

/**
 * Checks each rule's integrity (`verifyRuleChecksum` of `@run-iq/spec`) and its params.
 *
 * - checksum mismatch: `CHECKSUM_MISMATCH`, with `detail` naming the rule;
 * - malformed rule, whose checksum cannot be computed (`SpecError`, e.g. an invalid date, a
 *   non-integer version, or an `EXCEPTION_MODEL` rule without exceptions): `INVALID_RULE`, with
 *   `detail` naming the rule (`id@version`) and the `SpecError` message;
 * - params refused by a registered model: `INVALID_PARAMS`, with `detail` naming the rule, the
 *   model and the model's errors.
 *
 * The params of an `EXCEPTION_MODEL` rule are never validated: that model computes nothing, and
 * no plugin model registered under its name speaks for it.
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
      const detail = `Invalid rule ${String(rule.id)}@${String(rule.version)}: ${error.message}`;
      if (this.onChecksumMismatch === 'throw') {
        throw new ValidationError(detail, [detail]);
      }
      return { rule, reason: 'INVALID_RULE', detail };
    }

    if (!intact) {
      if (this.onChecksumMismatch === 'throw') {
        throw new Error(`Checksum mismatch for rule ${rule.id}`);
      }
      return {
        rule,
        reason: 'CHECKSUM_MISMATCH',
        detail: `Checksum mismatch for rule ${ruleLabel(rule)}`,
      };
    }

    // 2. Validate params via model (if registered)
    // Note: unregistered models are allowed here — plugins may handle them
    // in beforeEvaluate (e.g., meta-rules). ExecutionPipeline will skip them.
    if (rule.model !== EXCEPTION_MODEL && this.modelRegistry.has(rule.model)) {
      const model = this.modelRegistry.get(rule.model);
      const validation = model.validateParams(rule.params);
      if (!validation.valid) {
        const errors = validation.errors?.length
          ? validation.errors.join('; ')
          : 'the model gave no error';
        const detail = `Invalid params for rule ${ruleLabel(rule)} (model ${rule.model}): ${errors}`;
        return { rule, reason: 'INVALID_PARAMS', detail };
      }
    }

    return null;
  }
}
