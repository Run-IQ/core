import type { FactAssertion, JsonValue } from '@run-iq/spec';

export interface EvaluationInput {
  readonly data: Record<string, unknown>;
  readonly requestId: string;
  readonly meta: {
    readonly tenantId: string;
    readonly userId?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly context?: Record<string, unknown> | undefined;
    /**
     * The evaluation date. It is `meta.dates.effective` in the canonical input (`normalizeMeta`);
     * given with `dates.effective`, the two must name the same instant or date.
     */
    readonly effectiveDate?: Date | undefined;
    /**
     * Named dates (`effective`, `facture`...): a `Date`, a civil date `YYYY-MM-DD` or a date-time
     * with `Z` or an offset. Written canonically by `normalizeMeta`: a civil date stays civil, any
     * other becomes `YYYY-MM-DDTHH:MM:SS.sssZ`. Read as `/$dates/<name>`.
     */
    readonly dates?: Readonly<Record<string, string | Date>> | undefined;
    /**
     * The provenance of facts, dates and dimensions, by pointer of the evaluation context
     * (`/revenue/total`, `/$dates/facture`).
     */
    readonly assertions?: Readonly<Record<string, FactAssertion>> | undefined;
    /**
     * The input's value on each dimension (e.g. `{ country: 'TG' }`), or its several values
     * (`{ country: ['FR', 'US'] }`, written sorted without duplicates, one value as a string by
     * `normalizeMeta`). When present, a rule applies only if each of its dimensions matches
     * (`matchDimension` of `@run-iq/spec`: a value, or `{ anyOf, ... }`); `DIMENSION_MISMATCH`
     * otherwise, and a dimension the input lacks is a mismatch. Absent means no dimension
     * filtering. Read as `/$dimensions/<name>`.
     */
    readonly dimensions?: Readonly<Record<string, string | readonly string[]>> | undefined;
  };
}

/**
 * Turns a non-JSON fact of the input (e.g. a `Decimal`) into JSON before evaluation, so that what
 * models and conditions read, what the proof hashes and what a replay receives are the same data.
 * The first encoder whose `test` is true for a value encodes it, at any depth.
 */
export interface FactEncoder {
  /** Named in the errors about the values it produces. */
  readonly name: string;
  test(value: unknown): boolean;
  encode(value: unknown): JsonValue;
}
