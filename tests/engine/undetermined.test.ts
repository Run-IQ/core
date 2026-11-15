import { describe, it, expect } from 'vitest';
import * as core from '../../src/index.js';
import { isEngineError } from '../../src/errors/engineError.js';

// R11: `undetermined` and `isUndetermined`. The marker is an own, non-enumerable data property keyed
// by `Symbol.for('@run-iq/core/undetermined')`. A bad argument is an engine error (a ValidationError
// naming the call): the standing rule of 9L (AI7) holds for every export, so R11's `TypeError` is
// an engine error here; see the PR body, which asks for the ruling.

const KEY = Symbol.for('@run-iq/core/undetermined');

describe('R11: undetermined', () => {
  it('is recognised, frozen, and carries the marker as an own non-enumerable data property', () => {
    const result = core.undetermined(['/revenue']);
    expect(core.isUndetermined(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.missing)).toBe(true);
    expect(result.missing).toEqual(['/revenue']);
    expect('reason' in result).toBe(false);
    expect(Object.getOwnPropertyDescriptor(result, KEY)).toEqual({
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(Object.keys(result)).toEqual(['missing']);
  });

  it('keeps a given reason, copies the list, and does not share it with the caller', () => {
    const given = ['/a'];
    const result = core.undetermined(given, 'no revenue');
    given.push('/b');
    expect(result).toMatchObject({ missing: ['/a'], reason: 'no revenue' });
  });

  it('is false for an object without the marker, a lookalike, a string key, a proxy and a primitive', () => {
    expect(core.isUndetermined({ missing: [] })).toBe(false);
    expect(core.isUndetermined({ missing: [], undetermined: true })).toBe(false);
    expect(core.isUndetermined({ [KEY]: 'yes' })).toBe(false);
    expect(core.isUndetermined(null)).toBe(false);
    expect(core.isUndetermined('x')).toBe(false);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(core.isUndetermined(proxy)).toBe(false);
  });

  it('is told by the registered symbol alone: code in the same realm can write it (lesson 20)', () => {
    // Plugin code that builds this by hand is plugin code in the same realm: no in-process trick
    // stops it, and the engine reads what a model answers as plugin data anyway.
    expect(core.isUndetermined(Object.assign({ missing: [] }, { [KEY]: true }))).toBe(true);
  });

  it('a Proxy over a real marker is not the marker, and no trap runs', () => {
    const log: string[] = [];
    const proxy = new Proxy(core.undetermined([]), {
      getOwnPropertyDescriptor(t, k) {
        log.push('gopd');
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
      get(t, k) {
        log.push('get');
        return Reflect.get(t, k);
      },
    });
    expect(core.isUndetermined(proxy)).toBe(false);
    expect(log).toEqual([]);
  });

  it('a marker written with a string key, or an inherited one, is not the marker', () => {
    expect(core.isUndetermined({ '@run-iq/core/undetermined': true })).toBe(false);
    expect(core.isUndetermined(Object.create(core.undetermined([])))).toBe(false);
  });

  const refused = (run: () => unknown, text: RegExp): void => {
    let error: unknown;
    try {
      run();
    } catch (thrown) {
      error = thrown;
    }
    expect(isEngineError(error)).toBe(true);
    expect(Object.isFrozen(error)).toBe(true);
    expect((error as Error).message).toMatch(text);
  };

  it('refuses an item that is not a pointer, naming it', () => {
    refused(() => core.undetermined(['revenue']), /missing\[0\]/);
    refused(() => core.undetermined(['/ok', '']), /missing\[1\]/);
    refused(() => core.undetermined(['/a/-']), /missing\[0\]/);
    refused(() => core.undetermined(['/a~2']), /missing\[0\]/);
    refused(() => core.undetermined([5 as never]), /missing\[0\]/);
  });

  it('refuses a missing that is not a list and a reason that is not a string', () => {
    refused(() => core.undetermined('/a' as never), /undetermined/);
    refused(() => core.undetermined(undefined as never), /undetermined/);
    refused(() => core.undetermined(['/a'], 5 as never), /reason must be a string/);
  });

  it('a list with an accessor, an extra key, a hole or a Proxy is refused', () => {
    refused(
      () => core.undetermined(Object.defineProperty([], 0, { get: () => '/a', enumerable: true })),
      /undetermined/,
    );
    refused(() => core.undetermined(Object.assign(['/a'], { extra: 1 })), /undetermined/);
    refused(() => core.undetermined(new Proxy(['/a'], {})), /undetermined/);
  });
});
