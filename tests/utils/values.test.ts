import { describe, it, expect } from 'vitest';
import { copyData, describeThrown } from '../../src/utils/values.js';

describe('copyData', () => {
  it('copies arrays, plain objects and dates at every depth', () => {
    const original = { list: [{ n: 1 }], when: new Date(0), bare: Object.create(null) as object };
    const copy = copyData(original);
    expect(copy).toEqual(original);
    expect(copy.list).not.toBe(original.list);
    expect(copy.list[0]).not.toBe(original.list[0]);
    expect(copy.when).not.toBe(original.when);
    expect(copy.when.getTime()).toBe(0);
    expect(Object.getPrototypeOf(copy.bare)).toBeNull();
  });

  it('keeps class instances and functions by reference', () => {
    class Amount {
      constructor(readonly cents: number) {}
    }
    const amount = new Amount(5);
    const format = (): string => 'x';
    const copy = copyData({ amount, format });
    expect(copy.amount).toBe(amount);
    expect(copy.format).toBe(format);
  });

  it('copies shared and cyclic references once', () => {
    const shared = { n: 1 };
    const node: { self?: unknown; a: object; b: object } = { a: shared, b: shared };
    node.self = node;
    const copy = copyData(node);
    expect(copy.a).toBe(copy.b);
    expect(copy.a).not.toBe(shared);
    expect(copy.self).toBe(copy);
  });
});

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
