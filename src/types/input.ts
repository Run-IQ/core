import type { JsonValue } from '@run-iq/spec';

export interface EvaluationInput {
  readonly data: Record<string, unknown>;
  readonly requestId: string;
  readonly meta: {
    readonly tenantId: string;
    readonly userId?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly context?: Record<string, unknown> | undefined;
    readonly effectiveDate?: Date | undefined;
    /**
     * The input's value on each dimension (e.g. `{ country: 'TG' }`), one value per dimension.
     * When present, a rule applies only if each of its dimensions matches (`matchDimension` of
     * `@run-iq/spec`: a value, or `{ anyOf, ... }`); `DIMENSION_MISMATCH` otherwise, and a
     * dimension the input lacks is a mismatch. Absent means no dimension filtering.
     */
    readonly dimensions?: Readonly<Record<string, string>> | undefined;
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
