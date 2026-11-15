import type { DecisionProof, JsonValue } from '@run-iq/spec';
import type { Rule } from './rule.js';
import type { EvaluationTrace } from './trace.js';
import type { DecisionOutput } from './output.js';
import type { Diagnostic } from './diagnostic.js';
import type { PendingRule } from '../engine/ruleOutcome.js';

export type SkipReason =
  /** `meta.effectiveDate` is outside the half-open window `[effectiveFrom, effectiveUntil)`. */
  | 'INACTIVE_DATE'
  /** The rule's DSL condition evaluated to false. */
  | 'CONDITION_FALSE'
  /**
   * The rule's DSL condition threw.
   * @deprecated core reports it as a pending ERROR (`PendingRule`), never as an exclusion; the
   * reason stays in the type for the skips plugins return.
   */
  | 'DSL_ERROR'
  /**
   * No DSL evaluator is registered for the rule's `condition.dsl`.
   * @deprecated core reports it as a pending ERROR, never as an exclusion.
   */
  | 'DSL_NOT_FOUND'
  /**
   * The rule's `checksum` differs from the checksum of its content.
   * @deprecated core reports it as a pending ERROR, never as an exclusion.
   */
  | 'CHECKSUM_MISMATCH'
  /**
   * Malformed rule, checksum unverifiable: invalid or zone-less date, `effectiveUntil <=
   * effectiveFrom`, absent or non-string `checksum`, non-integer `version`, non-JSON value...
   * `detail` names the rule (`id@version`) and the reason.
   * @deprecated core reports it as a pending ERROR, never as an exclusion.
   */
  | 'INVALID_RULE'
  /**
   * A registered model refused the rule's params.
   * @deprecated core reports it as a pending ERROR, never as an exclusion.
   */
  | 'INVALID_PARAMS'
  /** The rule's tags do not intersect the input's `meta.tags`. */
  | 'TAG_MISMATCH'
  /** One of the rule's dimensions differs from, or is absent in, the input's `meta.dimensions`. */
  | 'DIMENSION_MISMATCH'
  /**
   * A higher-priority rule of the same `dominanceGroup` applies; `detail` names it (`id@version`).
   */
  | 'DOMINATED'
  /** A rule's `inhibit` exception targeted the rule; `detail` names the inhibiting rule. */
  | 'INHIBITED'
  /**
   * The rule's output declaration differs from another rule's for the same output, or the value it
   * computed does not match the declared type; `detail` says which.
   * @deprecated core reports it as a pending ERROR, never as an exclusion.
   */
  | 'OUTPUT_MISMATCH'
  /**
   * A plugin meta-rule inhibited the rule.
   * @deprecated Use `INHIBITED`. Removed when plugin-fiscal migrates (phase 3).
   */
  | 'INHIBITED_BY_META_RULE'
  /**
   * The rule does not apply to the input's country (set by plugins).
   * @deprecated Use `DIMENSION_MISMATCH`. Removed when plugin-fiscal migrates (phase 3).
   */
  | 'COUNTRY_MISMATCH'
  /**
   * A `shortCircuit` exception imposed the value of the rule's output, so the rule was not run;
   * `detail` names the short-circuiting rule. Also set by plugins that short-circuit.
   */
  | 'SHORT_CIRCUITED'
  /** Another rule with the same priority won the conflict (`onConflict: 'first'`). */
  | 'RULE_CONFLICT'
  /** No model is registered for the rule's `model` (for plugins; core throws `ModelNotFoundError`). */
  | 'MODEL_NOT_FOUND'
  /** A plugin skipped the rule in `beforeEvaluate`; `detail` carries the plugin's words. */
  | 'PLUGIN'
  /**
   * A model wrote into its frozen arguments (the rule, its params or the input): that rule is
   * excluded and `detail` says `wrote to its input: ...`.
   * @deprecated core reports it as a pending ERROR, never as an exclusion.
   */
  | 'MODEL_ERROR';

/** One contribution that entered the decision, as the trace step of the same rule records it. */
export interface BreakdownItem {
  readonly ruleId: string;
  readonly ruleVersion: number;
  /** The rule's reference to its legal or business source, when it has one. */
  readonly sourceRef?: string | undefined;
  /** The output the rule contributed to. */
  readonly output: string;
  readonly contribution: unknown;
  /** The contribution before rounding, present only when the output's rounding changed it. */
  readonly unrounded?: JsonValue | undefined;
  readonly modelUsed: string;
  readonly label?: string | undefined;
  readonly detail?: unknown;
}

export interface SkippedRule {
  readonly rule: Rule;
  readonly reason: SkipReason;
  /**
   * Why, when the reason alone does not say it (e.g. the `SpecError` of an `INVALID_RULE`). The
   * engine always sets it; it stays optional for the skips plugins return (`PluginSkip`).
   */
  readonly detail?: string | undefined;
  /**
   * The engine's own text for the proof (D-40): built from labels, names, pointers, codes and the
   * rule's own bounds only, never from an input value or from text a plugin produced. Required:
   * every skip the engine records has one.
   */
  readonly proofDetail: string;
}

/**
 * What a plugin returns as a skip from `beforeEvaluate`: the rule, the reason (`PLUGIN` only) and
 * its own words. It carries no `proofDetail`: the engine writes `skipped by plugin <name>`.
 */
export interface PluginSkip {
  readonly rule: Rule;
  readonly reason: SkipReason;
  readonly detail?: string | undefined;
}

export interface EvaluationResult {
  readonly requestId: string;
  /** The default output `value`, i.e. `outputs.value.value` (0 when no rule feeds it). */
  readonly value: unknown;
  /** Every output of the decision, by name. */
  readonly outputs: Readonly<Record<string, DecisionOutput>>;
  readonly breakdown: readonly BreakdownItem[];
  readonly appliedRules: readonly Rule[];
  readonly skippedRules: readonly SkippedRule[];
  /**
   * The rules whose decision the engine does not know, sorted by `id@version`: each with its
   * reason, its raw `detail`, its `proofDetail` and the facts it lacks. A rule is in exactly one of
   * `appliedRules`, `skippedRules` and `pendingRules`. Frozen; `afterEvaluate` cannot change it.
   */
  readonly pendingRules: readonly PendingRule[];
  /**
   * The labels (`id@version`) of the rules whose reads are not declared (D-39), sorted by
   * `id@version`, each once. Frozen.
   */
  readonly readsUndeclared: readonly string[];
  readonly trace: EvaluationTrace;
  /** What went wrong without stopping the evaluation (hook errors...). */
  readonly diagnostics: readonly Diagnostic[];
  /**
   * The JSON pointers (sorted by `comparePointers`) read by the conditions but absent from the
   * evaluation context: facts of `data`, `/$dates/...` and `/$dimensions/...`. The reads of a
   * model are not included yet, nor those of a rule whose `listVariables` does not conform
   * (its diagnostic says so; 9M1 adds the `provisional` status for such a rule).
   */
  readonly missingFacts: readonly string[];
  /** The `state` each plugin returned from `beforeEvaluate`, by plugin name. */
  readonly pluginState: Readonly<Record<string, JsonValue>>;
  /** The sealed proof of the decision, verifiable with `verifyProof` of `@run-iq/spec`. */
  readonly proof: DecisionProof;
  /** `true` when the decision was returned by the `DecisionStore` for an already seen `requestId`. */
  readonly fromStore: boolean;
  readonly engineVersion: string;
  readonly pluginVersions: Record<string, string>;
  readonly dslVersions: Record<string, string>;
  readonly timestamp: Date;
  readonly meta?: Record<string, unknown> | undefined;
}

/**
 * What core returns before Task 10 builds the proof: an `EvaluationResult` without its `proof`
 * and its `fromStore`. Derived from `EvaluationResult`, so every other member stays in sync; Task
 * 10 deletes this alias and the engine returns `EvaluationResult`.
 */
export type UnsealedResult = Omit<
  EvaluationResult,
  'proof' | 'fromStore' | 'pendingRules' | 'readsUndeclared'
> &
  /**
   * In this stacked change the engine does not fill the two lists yet (`PPEEngine.ts` is not
   * touched until the hand-back): they are optional here and required on `EvaluationResult`.
   */
  Partial<Pick<EvaluationResult, 'pendingRules' | 'readsUndeclared'>>;
