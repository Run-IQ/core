import { SpecError, toReferenceDate } from '@run-iq/spec';
import type { ProofInput } from '@run-iq/spec';
import { ValidationError } from '../errors/ValidationError.js';
import type { EvaluationInput } from '../types/input.js';

/** The `meta` of the canonical input (`ProofInput`), which `validateProofInput` checks. */
export type NormalizedMeta = ProofInput['meta'];

/** True for a non-null, non-array object: the only shape a map of the canonical meta may have. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `values` sorted by UTF-16 code unit without duplicates, as a new array. */
const sortedUnique = <T>(values: readonly T[]): T[] => [...new Set(values)].sort();

/** The reason a date is refused, at its name. */
function dateReason(where: string, error: unknown): string {
  return `${where}: ${error instanceof SpecError ? error.message : String(error)}`;
}

/**
 * The canonical `meta` of an input: what the proof hashes and what the rules read. Pure: the
 * caller's `meta` is not modified.
 * - `dates`: every value written by `toReferenceDate` (a civil date stays civil, any other date
 *   becomes the instant `YYYY-MM-DDTHH:MM:SS.sssZ`); `meta.effectiveDate` is `dates.effective`;
 * - `dimensions`: a list of values sorted by UTF-16 code unit without duplicates, one value
 *   written as a string;
 * - `tags`: sorted without duplicates;
 * - `context` and `assertions`: as given, `{}` when absent.
 *
 * Throws `ValidationError` (`Invalid evaluation input`) listing a date spec refuses
 * (`meta.dates.<name>: <message of spec>`, `meta.effectiveDate: ...`) and a `meta.effectiveDate`
 * that differs from `meta.dates.effective`. The rest (types, names) is checked on the result by
 * `validateProofInput`.
 */
export function normalizeMeta(meta: EvaluationInput['meta']): NormalizedMeta {
  const reasons: string[] = [];
  const dates: Record<string, string> = {};
  // A member of another type is passed on as it is, for `validateProofInput` to name.
  const datesIn = isRecord(meta.dates) ? meta.dates : {};
  for (const [name, value] of Object.entries(datesIn)) {
    try {
      dates[name] = toReferenceDate(value);
    } catch (error) {
      reasons.push(dateReason(`meta.dates.${name}`, error));
    }
  }
  if (meta.effectiveDate !== undefined) {
    try {
      const effective = toReferenceDate(meta.effectiveDate);
      if (dates['effective'] !== undefined && dates['effective'] !== effective) {
        reasons.push('meta.effectiveDate and meta.dates.effective differ');
      } else {
        dates['effective'] = effective;
      }
    } catch (error) {
      reasons.push(dateReason('meta.effectiveDate', error));
    }
  }
  if (reasons.length > 0) throw new ValidationError('Invalid evaluation input', reasons);

  const dimensions: Record<string, string | string[]> = {};
  const dimensionsIn = isRecord(meta.dimensions) ? meta.dimensions : {};
  for (const [name, value] of Object.entries(dimensionsIn)) {
    if (typeof value === 'string' || !Array.isArray(value)) {
      dimensions[name] = value as string;
      continue;
    }
    const values = sortedUnique(value as readonly string[]);
    dimensions[name] = values.length === 1 ? (values[0] as string) : values;
  }

  return {
    tenantId: meta.tenantId,
    dates: (isRecord(meta.dates) || meta.dates === undefined ? dates : meta.dates) as never,
    tags: (Array.isArray(meta.tags) ? sortedUnique(meta.tags) : (meta.tags ?? [])) as string[],
    dimensions: (isRecord(meta.dimensions) || meta.dimensions === undefined
      ? dimensions
      : meta.dimensions) as never,
    context: (meta.context === undefined ? {} : meta.context) as NormalizedMeta['context'],
    assertions: (meta.assertions === undefined
      ? {}
      : meta.assertions) as NormalizedMeta['assertions'],
  };
}

/**
 * The instant rules are evaluated at: `meta.dates.effective` (which is `meta.effectiveDate` when
 * that is given), or `undefined` when the input names none. A civil date is the start of that day
 * in UTC; the time zone of the rule set refines it in 9P. Throws like `normalizeMeta`.
 */
export function evaluationDate(meta: EvaluationInput['meta']): Date | undefined {
  const effective = normalizeMeta(meta).dates['effective'];
  if (effective === undefined) return undefined;
  // ECMAScript reads `YYYY-MM-DD` as midnight UTC, and the canonical instant as itself.
  return new Date(effective);
}
