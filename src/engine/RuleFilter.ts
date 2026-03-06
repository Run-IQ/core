import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { SkipReason } from '../types/result.js';
import type { DSLRegistry } from '../registry/DSLRegistry.js';
import type { PluginSandbox } from '../security/PluginSandbox.js';
import { DSLTimeoutError } from '../errors/DSLTimeoutError.js';

export interface FilterResult {
  readonly passed: readonly Rule[];
  readonly skipped: ReadonlyArray<{ rule: Rule; reason: SkipReason }>;
}

export class RuleFilter {
  constructor(
    private readonly dslRegistry: DSLRegistry,
    private readonly sandbox: PluginSandbox,
  ) {}

  async filter(
    rules: ReadonlyArray<Rule>,
    input: EvaluationInput,
    now: Date,
  ): Promise<FilterResult> {
    const passed: Rule[] = [];
    const skipped: Array<{ rule: Rule; reason: SkipReason }> = [];

    for (const rule of rules) {
      const skipReason = await this.checkRule(rule, input, now);
      if (skipReason) {
        skipped.push({ rule, reason: skipReason });
      } else {
        passed.push(rule);
      }
    }

    return { passed, skipped };
  }

  private async checkRule(
    rule: Rule,
    input: EvaluationInput,
    now: Date,
  ): Promise<SkipReason | null> {
    // 1. Date filter
    if (now < rule.effectiveFrom) {
      return 'INACTIVE_DATE';
    }
    if (rule.effectiveUntil !== null && now > rule.effectiveUntil) {
      return 'INACTIVE_DATE';
    }

    // 2. Tag filter
    const inputTags = input.meta.tags;
    if (inputTags && inputTags.length > 0 && rule.tags.length > 0) {
      const hasIntersection = rule.tags.some((tag) => inputTags.includes(tag));
      if (!hasIntersection) {
        return 'TAG_MISMATCH';
      }
    }

    // 3. DSL condition filter
    if (rule.condition) {
      const evaluator = this.dslRegistry.get(rule.condition.dsl);
      if (!evaluator) {
        return 'DSL_NOT_FOUND';
      }

      try {
        const result = await this.sandbox.runDSL(evaluator, rule.condition.value, input.data);
        if (!result) {
          return 'CONDITION_FALSE';
        }
      } catch (error) {
        if (error instanceof DSLTimeoutError) return 'CONDITION_TIMEOUT';
        return 'DSL_ERROR';
      }
    }

    return null;
  }
}
