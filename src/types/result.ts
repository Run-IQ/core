import type { Rule } from './rule.js';
import type { EvaluationTrace } from './trace.js';

export type SkipReason =
  | 'INACTIVE_DATE'
  | 'CONDITION_FALSE'
  | 'CONDITION_TIMEOUT'
  | 'DSL_ERROR'
  | 'DSL_NOT_FOUND'
  | 'CHECKSUM_MISMATCH'
  | 'INVALID_PARAMS'
  | 'TAG_MISMATCH'
  | 'INHIBITED_BY_META_RULE'
  | 'COUNTRY_MISMATCH'
  | 'SHORT_CIRCUITED'
  | 'RULE_CONFLICT';

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
