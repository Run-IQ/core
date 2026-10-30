import { canonicalize } from '@run-iq/spec';

/**
 * Canonical JSON of a value: `canonicalize` of `@run-iq/spec` (keys sorted at every depth,
 * `Date` as ISO string), or `undefined` for `undefined`. Throws `SpecError`
 * (`NON_SERIALIZABLE`) on `NaN`, `Infinity`, `bigint`, `Map`, `Set`, class instances and cycles.
 */
export function canonicalStringify(obj: unknown): string | undefined {
  return obj === undefined ? undefined : canonicalize(obj);
}
