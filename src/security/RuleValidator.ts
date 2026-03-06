import { createHash } from 'node:crypto';
import type { Rule } from '../types/rule.js';
import type { SkipReason } from '../types/result.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';

export interface RuleValidationResult {
  readonly valid: readonly Rule[];
  readonly invalid: ReadonlyArray<{ rule: Rule; reason: SkipReason }>;
}

export class RuleValidator {
  constructor(private readonly modelRegistry: ModelRegistry) {}

  validate(rules: ReadonlyArray<Rule>): RuleValidationResult {
    const valid: Rule[] = [];
    const invalid: Array<{ rule: Rule; reason: SkipReason }> = [];

    for (const rule of rules) {
      const reason = this.checkRule(rule);
      if (reason) {
        invalid.push({ rule, reason });
      } else {
        valid.push(rule);
      }
    }

    return { valid, invalid };
  }

  private checkRule(rule: Rule): SkipReason | null {
    // 1. Verify checksum
    // v1: checksum covers params only. v2 could extend to condition + priority + model
    // to detect broader tampering. Acceptable for v1 since params drive calculation output.
    const computedChecksum = createHash('sha256').update(JSON.stringify(rule.params)).digest('hex');

    if (computedChecksum !== rule.checksum) {
      return 'CHECKSUM_MISMATCH';
    }

    // 2. Validate params via model
    if (this.modelRegistry.has(rule.model)) {
      const model = this.modelRegistry.get(rule.model);
      const validation = model.validateParams(rule.params);
      if (!validation.valid) {
        return 'INVALID_PARAMS';
      }
    }

    return null;
  }
}
