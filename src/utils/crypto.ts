import { createHash } from 'node:crypto';
import { canonicalStringify } from './json.js';

export function hashParams(params: unknown): string {
  const serialized = canonicalStringify(params) ?? 'null';
  return createHash('sha256').update(serialized).digest('hex');
}
