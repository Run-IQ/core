import type { EvaluationResult } from './result.js';

/**
 * Where the engine keeps its decisions, for idempotence: an evaluation whose `requestId` is
 * already stored with the same input digest returns the stored decision. `dryRun` stores nothing.
 *
 * A persistent store may round-trip decisions through JSON (`Date` values come back as strings):
 * the engine compares `proof.inputDigest`, never objects.
 */
export interface DecisionStore {
  save(decision: EvaluationResult): Promise<void>;
  /** `null` when no decision is stored for `requestId`. */
  findByRequestId(requestId: string): Promise<EvaluationResult | null>;
}
