import { describe, it, expect } from 'vitest';
import { buildContext } from '../../src/context/buildContext.js';
import type { ContextBase } from '../../src/context/buildContext.js';

const base = (): ContextBase => ({
  data: { revenue: { total: 1200 }, amount: 5, children: [{ age: 4 }] },
  dates: { effective: '2026-01-01T00:00:00.000Z', birth: '1990-05-05' },
  dimensions: { country: 'TG', zone: ['EU', 'FR'] },
  outputs: { risk: { level: 'high' }, total: 42, prime: 7 },
});

describe('buildContext', () => {
  it('has data at the root, then $dates, $dimensions and the outputs that are read', () => {
    const context = buildContext(base(), { outputs: ['risk', 'total'] });
    expect(context).toEqual({
      revenue: { total: 1200 },
      amount: 5,
      children: [{ age: 4 }],
      $dates: { effective: '2026-01-01T00:00:00.000Z', birth: '1990-05-05' },
      $dimensions: { country: 'TG', zone: ['EU', 'FR'] },
      $outputs: { risk: { level: 'high' }, total: 42 },
    });
  });

  it('leaves out an output that is not read, and one that does not exist', () => {
    const context = buildContext(base(), { outputs: ['risk', 'absent'] });
    expect(context['$outputs']).toEqual({ risk: { level: 'high' } });
    expect(Object.keys(context['$outputs'] as object)).toEqual(['risk']);
    expect(Object.hasOwn(context['$outputs'] as object, 'prime')).toBe(false);
  });

  it('has an empty $outputs when no output is read, or none exists yet', () => {
    expect(buildContext(base(), { outputs: [] })['$outputs']).toEqual({});
    const { data, dates, dimensions } = base();
    const withoutOutputs: ContextBase = { data, dates, dimensions };
    expect(buildContext(withoutOutputs, { outputs: ['risk'] })['$outputs']).toEqual({});
  });

  it('is frozen, with its $ variables', () => {
    const context = buildContext(base(), { outputs: ['risk'] });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context['$dates'])).toBe(true);
    expect(Object.isFrozen(context['$dimensions'])).toBe(true);
    expect(Object.isFrozen(context['$outputs'])).toBe(true);
    expect(() => {
      (context as Record<string, unknown>)['amount'] = 1;
    }).toThrow(TypeError);
    expect(() => {
      (context['$dates'] as Record<string, unknown>)['effective'] = 'x';
    }).toThrow(TypeError);
  });

  it('does not modify or freeze the data of the caller, and shares its nested values', () => {
    const given = base();
    const before = JSON.stringify(given);
    const context = buildContext(given, { outputs: ['risk'] });
    expect(JSON.stringify(given)).toBe(before);
    expect(Object.isFrozen(given.data)).toBe(false);
    expect(context).not.toBe(given.data);
    // The nested values are the caller's own: nothing is copied (a copy per rule would not scale).
    expect(context['revenue']).toBe(given.data['revenue']);
  });

  it('copies the dates and the dimensions: a later change of the base does not reach it', () => {
    const given = { ...base(), dates: { effective: '2026-01-01' } as Record<string, string> };
    const context = buildContext(given, { outputs: [] });
    given.dates['effective'] = '2030-01-01';
    expect(context['$dates']).toEqual({ effective: '2026-01-01' });
  });

  describe('the variables of an instance', () => {
    it('adds the engine variables it is given', () => {
      const context = buildContext(
        base(),
        { outputs: [] },
        { $item: { age: 4 }, $index: 0, $params: { rate: 0.2 } },
      );
      expect(context['$item']).toEqual({ age: 4 });
      expect(context['$index']).toBe(0);
      expect(context['$params']).toEqual({ rate: 0.2 });
      expect(Object.isFrozen(context)).toBe(true);
    });

    it('refuses a name that is not an engine variable', () => {
      expect(() => buildContext(base(), { outputs: [] }, { item: 1 } as never)).toThrow(
        new TypeError('buildContext: item is not an instance variable'),
      );
      expect(() => buildContext(base(), { outputs: [] }, { $foo: 1 } as never)).toThrow(
        new TypeError('buildContext: $foo is not an instance variable'),
      );
    });

    it('refuses to replace a variable the context builds itself', () => {
      for (const name of ['$dates', '$dimensions', '$outputs']) {
        expect(() => buildContext(base(), { outputs: [] }, { [name]: 1 } as never)).toThrow(
          new TypeError(`buildContext: ${name} is not an instance variable`),
        );
      }
    });
  });
});
