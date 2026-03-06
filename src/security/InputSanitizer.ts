import type { EvaluationInput } from '../types/input.js';
import { ValidationError } from '../errors/ValidationError.js';

export class InputSanitizer {
  static validate(input: unknown): asserts input is EvaluationInput {
    const reasons: string[] = [];

    if (input === null || typeof input !== 'object') {
      throw new ValidationError('Input must be a non-null object', ['Input is not an object']);
    }

    const obj = input as Record<string, unknown>;

    if (typeof obj['requestId'] !== 'string' || obj['requestId'].length === 0) {
      reasons.push('requestId must be a non-empty string');
    }

    if (obj['data'] === null || typeof obj['data'] !== 'object' || Array.isArray(obj['data'])) {
      reasons.push('data must be a non-null object');
    }

    if (obj['meta'] === null || typeof obj['meta'] !== 'object' || Array.isArray(obj['meta'])) {
      reasons.push('meta must be a non-null object');
    } else {
      const meta = obj['meta'] as Record<string, unknown>;
      if (typeof meta['tenantId'] !== 'string' || meta['tenantId'].length === 0) {
        reasons.push('meta.tenantId must be a non-empty string');
      }
    }

    if (reasons.length > 0) {
      throw new ValidationError('Invalid evaluation input', reasons);
    }
  }
}
