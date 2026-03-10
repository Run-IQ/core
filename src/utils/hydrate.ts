import type { Rule } from '../types/rule.js';
import { ValidationError } from '../errors/ValidationError.js';

export function hydrateRule(raw: Record<string, unknown>): Rule {
  if (typeof raw.id !== 'string') {
    throw new ValidationError('rule.id must be a string', ['rule.id must be a string']);
  }
  if (typeof raw.model !== 'string') {
    throw new ValidationError('rule.model must be a string', ['rule.model must be a string']);
  }
  if (typeof raw.priority !== 'number') {
    throw new ValidationError('rule.priority must be a number', ['rule.priority must be a number']);
  }
  if (typeof raw.version !== 'number') {
    throw new ValidationError('rule.version must be a number', ['rule.version must be a number']);
  }
  if (typeof raw.checksum !== 'string') {
    throw new ValidationError('rule.checksum must be a string', ['rule.checksum must be a string']);
  }

  // justification: validated above — required fields are type-checked
  return {
    ...raw,
    effectiveFrom: new Date(raw.effectiveFrom as string),
    effectiveUntil: raw.effectiveUntil != null ? new Date(raw.effectiveUntil as string) : null,
  } as Rule;
}

export function hydrateRules(rawRules: Record<string, unknown>[]): Rule[] {
  return rawRules.map(hydrateRule);
}
