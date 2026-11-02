import { describe, it, expect } from 'vitest';
import { formatPointer, parsePointer } from '@run-iq/spec';
import * as core from '../src/index.js';
import { DEFAULT_LIMITS } from '../src/limits.js';

describe('the public surface of 9L', () => {
  it('re-exports the pointer functions of spec themselves, not copies', () => {
    expect(core.parsePointer).toBe(parsePointer);
    expect(core.formatPointer).toBe(formatPointer);
    expect(core.formatPointer(core.parsePointer('/a~1b/~0c'))).toBe('/a~1b/~0c');
  });

  it('exports the limits, the error, the reads, the context and the meta', () => {
    expect(core.DEFAULT_LIMITS).toBe(DEFAULT_LIMITS);
    expect(core.EngineLimitError).toBeTypeOf('function');
    expect(core.DuplicateRequestError).toBeTypeOf('function');
    for (const name of [
      'resolveLimits',
      'readsOf',
      'buildContext',
      'normalizeMeta',
      'evaluationDate',
    ]) {
      expect(core[name as keyof typeof core], name).toBeTypeOf('function');
    }
  });
});
