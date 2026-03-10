import { createHash } from 'node:crypto';
import { canonicalStringify } from './json.js';

export function hashParams(params: unknown): string {
  const serialized = canonicalStringify(params) ?? 'null';
  return createHash('sha256').update(serialized).digest('hex');
}

/**
 * Computes a SHA-256 checksum of the entire rule object, excluding the
 * `checksum` field itself. All fields present on the rule contribute to
 * the hash — missing/optional fields are simply absent from the digest.
 * Key order is irrelevant thanks to canonicalStringify.
 */
export function computeRuleChecksum(rule: object): string {
  // justification: extracting own enumerable entries to build a checksum-free copy for hashing
  const entries = Object.entries(rule).filter(([key]) => key !== 'checksum');
  return hashParams(Object.fromEntries(entries));
}
