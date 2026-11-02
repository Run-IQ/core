import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { Diagnostic } from '../types/diagnostic.js';
import type { SkippedRule } from '../types/result.js';
import type { DSLRegistry } from '../registry/DSLRegistry.js';
import type { PluginSandbox } from '../security/PluginSandbox.js';
import { SpecError, canonicalize, isEffectiveAt, matchDimension } from '@run-iq/spec';
import type { DimensionSpec, Referential } from '@run-iq/spec';
import { DSLEvaluationError } from '../errors/DSLEvaluationError.js';
import { DSLTimeoutError } from '../errors/DSLTimeoutError.js';
import { describeThrown } from '../utils/values.js';

export interface FilterResult {
  readonly passed: readonly Rule[];
  readonly skipped: readonly SkippedRule[];
  /** Sorted, unique dotted paths read by the evaluated conditions but absent from `input.data`. */
  readonly missingFacts: readonly string[];
  /** Non-fatal problems met while filtering (a failing `listVariables`). */
  readonly diagnostics: readonly Diagnostic[];
}

type Exclusion = Pick<SkippedRule, 'reason'> & { readonly detail: string };

/**
 * Resolves a dotted path object by object. Only own enumerable properties count (inherited ones
 * such as `constructor`, and array `length`, are not facts); an own array index does. A
 * non-object intermediate makes the path unresolvable.
 */
function resolvePath(data: Record<string, unknown>, path: string): unknown {
  let current: unknown = data;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (!Object.prototype.propertyIsEnumerable.call(current, key)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** The referentials the dimension filter can resolve a `ref` in: none until 9Q provides them. */
const NO_REFERENTIALS: ReadonlyMap<string, Referential> = new Map();

/** A rule's dimension as the detail names it: a plain value as written, a spec in JSON. */
const describeSpec = (spec: DimensionSpec): string =>
  typeof spec === 'string' ? spec : canonicalize(spec);

/** A bound as the detail names it: a civil date as written, an instant in ISO form. */
function formatDate(date: string | Date): string {
  if (typeof date === 'string') return date;
  return Number.isNaN(date.getTime()) ? 'Invalid Date' : date.toISOString();
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
    const diagnostics: Diagnostic[] = [];

    for (const rule of rules) {
      const exclusion = await this.checkRule(rule, input, now, missing, diagnostics);
      if (exclusion) {
        skipped.push({ rule, reason: exclusion.reason, detail: exclusion.detail });
      } else {
        passed.push(rule);
      }
    }

    return { passed, skipped, missingFacts: [...missing].sort(), diagnostics };
  }

  private async checkRule(
    rule: Rule,
    input: EvaluationInput,
    now: Date,
    missing: Set<string>,
    diagnostics: Diagnostic[],
  ): Promise<Exclusion | null> {
    // 1. Date filter: half-open window [effectiveFrom, effectiveUntil)
    if (!isEffectiveAt(rule, now)) {
      const until = rule.effectiveUntil === null ? 'infinity' : formatDate(rule.effectiveUntil);
      return {
        reason: 'INACTIVE_DATE',
        detail: `window [${formatDate(rule.effectiveFrom)}, ${until}), evaluated at ${formatDate(now)}`,
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

    // 3. Dimension filter (only when the input declares dimensions), by spec's matchDimension
    const inputDimensions = input.meta.dimensions;
    if (inputDimensions !== undefined && rule.dimensions !== undefined) {
      // The civil date of the evaluation, in UTC: 9P refines it (the rule's reference date).
      const on = now.toISOString().slice(0, 10);
      for (const [key, spec] of Object.entries(rule.dimensions)) {
        const actual = Object.hasOwn(inputDimensions, key) ? inputDimensions[key] : undefined;
        const rulePart = `${key}: rule ${describeSpec(spec)}`;
        if (actual === undefined) {
          return { reason: 'DIMENSION_MISMATCH', detail: `${rulePart}, input has no ${key}` };
        }
        let match: ReturnType<typeof matchDimension>;
        try {
          match = matchDimension(spec, actual, on, NO_REFERENTIALS);
        } catch (error) {
          // A rule spec or a referential refuses (`unknown referential`): named, never a mismatch.
          if (!(error instanceof SpecError)) throw error;
          return {
            reason: 'INVALID_RULE',
            detail: `Invalid rule ${rule.id}@${rule.version}: dimension ${key}: ${error.message}`,
          };
        }
        if (match.result !== true) {
          const unknown = match.result === 'unknown' ? ` (unknown: ${match.why})` : '';
          return {
            reason: 'DIMENSION_MISMATCH',
            detail: `${rulePart}, input ${actual}${unknown}`,
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

      // listVariables only feeds missingFacts: its failure never changes the rule's outcome.
      if (evaluator.listVariables) {
        try {
          // Collected first: a lazy iterable throwing midway contributes nothing.
          const absent = [...evaluator.listVariables(rule.condition.value)].filter(
            (path) => path !== '' && resolvePath(input.data, path) === undefined,
          );
          for (const path of absent) missing.add(path);
        } catch (error) {
          diagnostics.push({
            source: 'engine',
            message: `listVariables failed for ${rule.id}@${rule.version} (${rule.condition.dsl}): ${describeThrown(error)}`,
          });
        }
      }

      try {
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
