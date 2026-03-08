import { createHash } from 'node:crypto';
import type { Rule } from '../types/rule.js';
import type { SkipReason } from '../types/result.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';

export interface RuleValidationResult {
  readonly valid: readonly Rule[];
  readonly invalid: ReadonlyArray<{ rule: Rule; reason: SkipReason }>;
}

export class RuleValidator {
  constructor(
    private readonly modelRegistry: ModelRegistry,
    private readonly onChecksumMismatch: 'throw' | 'skip' = 'skip'
  ) {}

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
    const computedChecksum = createHash('sha256').update(JSON.stringify(rule.params)).digest('hex');

    if (computedChecksum !== rule.checksum) {
      if (this.onChecksumMismatch === 'throw') {
        throw new Error(`Checksum mismatch for rule ${rule.id}`);
      }
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
