import { describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// Only portable JSON reaches the hooks, the rules and the models: anything else is refused with
// its pointer, before the first hook runs and before anything is computed or saved.

class Custom {
  readonly a = 1;
}

const CASES: ReadonlyArray<readonly [string, unknown, string]> = [
  ['NaN', NaN, 'is not JSON: NaN'],
  ['Infinity', Infinity, 'is not JSON: Infinity'],
  ['-Infinity', -Infinity, 'is not JSON: -Infinity'],
  ['a Date', new Date(0), 'is not JSON: a Date: write it as a string'],
  ['a function', () => 1, 'is not JSON: a function'],
  ['a symbol', Symbol('s'), 'is not JSON: a symbol'],
  ['a BigInt', 1n, 'is not JSON: a bigint'],
  ['a Map', new Map(), 'is not JSON: an object that is neither plain nor an array'],
  ['a Set', new Set(), 'is not JSON: an object that is neither plain nor an array'],
  ['a class instance', new Custom(), 'is not JSON: an object that is neither plain nor an array'],
  ['a typed array', new Uint8Array(2), 'is not JSON: an object that is neither plain nor an array'],
  ['a RegExp', /a/, 'is not JSON: an object that is neither plain nor an array'],
  ['an Error', new Error('e'), 'is not JSON: an object that is neither plain nor an array'],
  ['a boxed number', Object(1), 'is not JSON: an object that is neither plain nor an array'],
];

function setup() {
  const adapter = new InMemorySnapshotAdapter();
  const beforeEvaluate = vi.fn((input, rules) => ({ input, rules }));
  const afterEvaluate = vi.fn((_input, result) => result);
  const model = new StubModel('M', 10);
  const calculate = vi.spyOn(model, 'calculate');
  const plugin: PPEPlugin = {
    name: 'p',
    version: '1.0.0',
    onInit(context: PluginContext): void {
      context.modelRegistry.register(model);
    },
    beforeEvaluate,
    afterEvaluate,
  };
  const engine = new PPEEngine({ plugins: [plugin], dsls: [], strict: false, snapshot: adapter });
  return { engine, adapter, beforeEvaluate, afterEvaluate, calculate };
}

async function refused(
  s: ReturnType<typeof setup>,
  data: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Promise<ValidationError> {
  const input = makeInput({ data, meta: { tenantId: 't', ...meta } as never });
  const error = await s.engine.evaluate([makeRule({ id: 'r1', model: 'M' })], input).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ValidationError);
  expect(s.beforeEvaluate).not.toHaveBeenCalled();
  expect(s.afterEvaluate).not.toHaveBeenCalled();
  expect(s.calculate).not.toHaveBeenCalled();
  expect(await s.adapter.exists(input.requestId)).toBe(false);
  return error as ValidationError;
}

describe('input values that are not portable JSON are refused before any hook', () => {
  it.each(CASES)('%s in data', async (_label, value, why) => {
    const error = await refused(setup(), { x: value });
    expect(error.reasons).toEqual([`/data/x ${why}`]);
  });

  it.each(CASES)('%s inside a list of data', async (_label, value, why) => {
    const error = await refused(setup(), { x: [1, value] });
    expect(error.reasons).toEqual([`/data/x/1 ${why}`]);
  });

  it.each(CASES)('%s in meta.context', async (_label, value, why) => {
    const error = await refused(setup(), { a: 1 }, { context: { k: value } });
    expect(error.reasons).toEqual([`/meta/context/k ${why}`]);
  });

  it('undefined inside an object', async () => {
    const error = await refused(setup(), { x: undefined });
    expect(error.reasons).toEqual(['/data/x is not JSON: undefined']);
  });

  it('undefined inside a list', async () => {
    const error = await refused(setup(), { x: [1, undefined] });
    expect(error.reasons).toEqual(['/data/x/1 is not JSON: undefined']);
  });

  it('a hole in a list', async () => {
    // eslint-disable-next-line no-sparse-arrays
    const error = await refused(setup(), { x: [1, , 3] });
    expect(error.reasons).toEqual(['/data/x has a hole at index 1: arrays must be dense']);
  });

  it('names every offending value, not only the first', async () => {
    const error = await refused(setup(), { x: NaN, y: 1n, z: [() => 1] });
    expect(error.reasons).toEqual([
      '/data/x is not JSON: NaN',
      '/data/y is not JSON: a bigint',
      '/data/z/0 is not JSON: a function',
    ]);
  });
});
