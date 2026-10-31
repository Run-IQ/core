import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { SkippedRule } from '../types/result.js';
import type { DSLRegistry } from '../registry/DSLRegistry.js';
import type { PluginSandbox } from '../security/PluginSandbox.js';
import { isEffectiveAt } from '@run-iq/spec';
import { DSLEvaluationError } from '../errors/DSLEvaluationError.js';
import { DSLTimeoutError } from '../errors/DSLTimeoutError.js';

export interface FilterResult {
  readonly passed: readonly Rule[];
  readonly skipped: readonly SkippedRule[];
  /** Sorted, unique dotted paths read by the evaluated conditions but absent from `input.data`. */
  readonly missingFacts: readonly string[];
}

type Exclusion = Pick<SkippedRule, 'reason'> & { readonly detail: string };

function resolvePath(data: Record<string, unknown>, path: string): unknown {
  let current: unknown = data;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(key in current)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
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
    const skipped: SkippedRule[] = [];
    const missing = new Set<string>();

    for (const rule of rules) {
      const exclusion = await this.checkRule(rule, input, now, missing);
      if (exclusion) {
        skipped.push({ rule, reason: exclusion.reason, detail: exclusion.detail });
      } else {
        passed.push(rule);
      }
    }

    return { passed, skipped, missingFacts: [...missing].sort() };
  }

  private async checkRule(
    rule: Rule,
    input: EvaluationInput,
    now: Date,
    missing: Set<string>,
  ): Promise<Exclusion | null> {
    // 1. Date filter: half-open window [effectiveFrom, effectiveUntil)
    if (!isEffectiveAt(rule, now)) {
      const until = rule.effectiveUntil === null ? 'infinity' : rule.effectiveUntil.toISOString();
      return {
        reason: 'INACTIVE_DATE',
        detail: `window [${rule.effectiveFrom.toISOString()}, ${until}), evaluated at ${now.toISOString()}`,
      };
    }

    // 2. Tag filter
    const inputTags = input.meta.tags;
    if (inputTags && inputTags.length > 0 && rule.tags.length > 0) {
      const hasIntersection = rule.tags.some((tag) => inputTags.includes(tag));
      if (!hasIntersection) {
        return {
          reason: 'TAG_MISMATCH',
          detail: `rule tags [${rule.tags.join(', ')}], input tags [${inputTags.join(', ')}]`,
        };
      }
    }

    // 3. Dimension filter (only when the input declares dimensions)
    const inputDimensions = input.meta.dimensions;
    if (inputDimensions !== undefined && rule.dimensions !== undefined) {
      for (const [key, expected] of Object.entries(rule.dimensions)) {
        const actual = Object.hasOwn(inputDimensions, key) ? inputDimensions[key] : undefined;
        if (actual !== expected) {
          return {
            reason: 'DIMENSION_MISMATCH',
            detail: `${key}: rule ${expected}, input ${actual ?? '(absent)'}`,
          };
        }
      }
    }

    // 4. DSL condition filter
    if (rule.condition) {
      const evaluator = this.dslRegistry.get(rule.condition.dsl);
      if (!evaluator) {
        return { reason: 'DSL_NOT_FOUND', detail: `DSL not found: ${rule.condition.dsl}` };
      }

      try {
        if (evaluator.listVariables) {
          for (const path of evaluator.listVariables(rule.condition.value)) {
            if (resolvePath(input.data, path) === undefined) missing.add(path);
          }
        }
        const result = await this.sandbox.runDSL(evaluator, rule.condition.value, input.data);
        if (!result) {
          return { reason: 'CONDITION_FALSE', detail: 'condition evaluated to false' };
        }
      } catch (error) {
        if (error instanceof DSLTimeoutError) {
          return { reason: 'CONDITION_TIMEOUT', detail: error.message };
        }
        const cause = error instanceof DSLEvaluationError ? error.originalError : error;
        return {
          reason: 'DSL_ERROR',
          detail: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }

    return null;
  }
}
