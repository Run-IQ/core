import type { JsonPointer } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';

/**
 * What a rule is at the end of an evaluation (9M1, R1): applied (its computation or short-circuit
 * took effect), skipped (known not to apply, with a `SkipReason`) or pending (the engine does not
 * know whether, or with what value, the rule applies). Every rule ends in exactly one state.
 */
export type RuleState = 'applied' | 'skipped' | 'pending';

/**
 * Why a rule is pending (D-8). In 9M1 the engine writes `UNDETERMINED` and `ERROR` and, under the
 * interim guard, `PENDING_CARRIER` and `PENDING_DOMINANT`; `AMBIGUOUS_ORDER` is declared and never
 * written (9R2).
 */
export type PendingReason =
  'UNDETERMINED' | 'ERROR' | 'AMBIGUOUS_ORDER' | 'PENDING_CARRIER' | 'PENDING_DOMINANT';

/**
 * A rule whose decision is not known. `detail` is the raw message, useful for debugging; for a
 * pending `ERROR` it starts with its cause (`<CAUSE>: <message>`, one of spec's `ERROR_CAUSES`).
 * `proofDetail` is the engine's own template (D-40): built from labels, names, pointers and codes
 * only, never from an input value or from text a plugin produced. `missing` lists, sorted without
 * duplicates, the facts the decision lacks (`[]` for an `ERROR`). The entry, its `missing` and its
 * `rule` are frozen. (`subject` and `stratum` come with 9R1 and 9N.)
 */
export interface PendingRule {
  readonly rule: Rule;
  readonly reason: PendingReason;
  readonly detail: string;
  readonly proofDetail: string;
  readonly missing: readonly JsonPointer[];
}
