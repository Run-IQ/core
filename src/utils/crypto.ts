import { createHash } from 'node:crypto';
import { canonicalStringify } from './json.js';

export function hashParams(params: unknown): string {
  const serialized = canonicalStringify(params) ?? 'null';
  return createHash('sha256').update(serialized).digest('hex');
}

/**
 * Computes a checksum for the critical parts of a rule to ensure integrity.
 */
export function computeRuleChecksum(rule: {
  model: string;
  params: unknown;
  condition?: unknown;
  priority: number;
}): string {
  const criticalData = {
    model: rule.model,
    params: rule.params,
    condition: rule.condition,
    priority: rule.priority,
  };
  return hashParams(criticalData);
}
