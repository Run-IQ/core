import { describe, it, expect } from 'vitest';
import { describeThrown } from '../../src/utils/values.js';

describe('describeThrown', () => {
  it('never throws, even on a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    // A Proxy is described by a fixed text, no trap run (AK9).
    expect(describeThrown(proxy)).toBe('(a Proxy)');
    expect(describeThrown(new Error('boom'))).toBe('boom');
  });

  it('AI3: never runs the conversion of a thrown object, and bounds its text', () => {
    const calls: string[] = [];
    const trap = {
      toString: () => (calls.push('toString'), 'x'),
      [Symbol.toPrimitive]: () => (calls.push('toPrimitive'), 'x'),
    };
    expect(describeThrown(trap)).toBe('Error');
    expect(calls).toEqual([]);
    const getter = Object.defineProperty(new Error('x'), 'message', {
      get() {
        throw new Error('getter ran');
      },
    });
    expect(describeThrown(getter)).toBe('Error');
    expect(describeThrown(new Error('m'.repeat(200_000))).length).toBeLessThan(1100);
  });
});
