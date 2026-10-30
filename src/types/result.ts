import type { Rule } from './rule.js';
import type { EvaluationTrace } from './trace.js';

export type SkipReason =
  /** `meta.effectiveDate` is outside `[effectiveFrom, effectiveUntil]` (both inclusive in core). */
  | 'INACTIVE_DATE'
  /** The rule's DSL condition evaluated to false. */
  | 'CONDITION_FALSE'
  /** The rule's DSL condition exceeded `timeout.dsl`. */
  | 'CONDITION_TIMEOUT'
  /** The rule's DSL condition threw. */
  | 'DSL_ERROR'
  /** No DSL evaluator is registered for the rule's `condition.dsl`. */
  | 'DSL_NOT_FOUND'
  /** The rule's `checksum` differs from the checksum of its content. */
  | 'CHECKSUM_MISMATCH'
  /**
   * Malformed rule, checksum unverifiable: invalid or zone-less date, `effectiveUntil <=
   * effectiveFrom`, absent or non-string `checksum`, non-integer `version`, non-JSON value...
   * `detail` names the rule (`id@version`) and the reason.
   */
  | 'INVALID_RULE'
  /** A registered model refused the rule's params. */
  | 'INVALID_PARAMS'
  /** The rule's tags do not intersect the input's `meta.tags`. */
  | 'TAG_MISMATCH'
  /** A plugin meta-rule inhibited the rule. */
  | 'INHIBITED_BY_META_RULE'
  /** The rule does not apply to the input's country (set by plugins). */
  | 'COUNTRY_MISMATCH'
  /** A plugin short-circuited the evaluation, so the rule was not run. */
  | 'SHORT_CIRCUITED'
  /** Another rule with the same priority won the conflict (`onConflict: 'first'`). */
  | 'RULE_CONFLICT'
  /** No model is registered for the rule's `model` (for plugins; core throws `ModelNotFoundError`). */
  | 'MODEL_NOT_FOUND';

export interface BreakdownItem {
  readonly ruleId: string;
  readonly contribution: unknown;
  readonly modelUsed: string;
  readonly label?: string | undefined;
  readonly detail?: unknown;
}

export interface SkippedRule {
  readonly rule: Rule;
  readonly reason: SkipReason;
  /** Why, when the reason alone does not say it (e.g. the `SpecError` of an `INVALID_RULE`). */
  readonly detail?: string | undefined;
}

export interface EvaluationResult {
  readonly requestId: string;
  readonly value: unknown;
  readonly breakdown: readonly BreakdownItem[];
  readonly appliedRules: readonly Rule[];
  readonly skippedRules: readonly SkippedRule[];
  readonly trace: EvaluationTrace;
  readonly snapshotId: string;
  readonly engineVersion: string;
  readonly pluginVersions: Record<string, string>;
  readonly dslVersions: Record<string, string>;
  readonly timestamp: Date;
  readonly meta?: Record<string, unknown> | undefined;
}
