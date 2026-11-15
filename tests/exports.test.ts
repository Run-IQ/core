import { describe, it, expect } from 'vitest';
import { formatPointer, parsePointer } from '@run-iq/spec';
import * as core from '../src/index.js';
import { DEFAULT_LIMITS } from '../src/limits.js';

describe('the public surface of 9L', () => {
  it('re-exports the pointer functions of spec, guarded: the same answers', () => {
    // Guarded (AI7: a bad argument is an engine error, never spec's own), so not the same function.
    expect(core.parsePointer('/a/b')).toEqual(parsePointer('/a/b'));
    expect(core.formatPointer(parsePointer('/a~1b'))).toBe(formatPointer(parsePointer('/a~1b')));
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
