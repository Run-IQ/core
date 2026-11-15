import { describe, it, expect, vi } from 'vitest';

// AI1: whatever goes wrong while the engine is built, the caller receives an engine error. A raw
// failure of an internal piece (simulated here) is wrapped, by identity, holding its text only.
vi.mock('../../src/snapshot/SnapshotManager.js', () => ({
  SnapshotManager: class {
    constructor() {
      throw Object.assign(new RangeError('internal failure'), { secret: { token: 'hunter2' } });
    }
  },
}));

import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { UnexpectedEngineError } from '../../src/errors/UnexpectedEngineError.js';
import { isEngineError } from '../../src/errors/engineError.js';

describe('AI1: the constructor net', () => {
  it('wraps an internal raw failure in a frozen UnexpectedEngineError, text only', () => {
    let error: unknown;
    try {
      new PPEEngine({ plugins: [], dsls: [] });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect(isEngineError(error)).toBe(true);
    expect(Object.isFrozen(error)).toBe(true);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('hunter2');
    expect((error as Error).message).toBe('internal failure');
  });
});
