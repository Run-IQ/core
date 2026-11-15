import { describe, it, expect } from 'vitest';
import * as errors from '../../src/errors/index.js';
import { attributeLimit } from '../../src/errors/EngineLimitError.js';
import { PPEEngine } from '../../src/engine/PPEEngine.js';

/**
 * AG1 (B74): every error the caller can receive is frozen at creation, deeply, so nothing the
 * caller holds can be changed. One instance of every exported error class is built here; adding a
 * class to the index without a sample below fails the first test.
 */
const nested = new errors.ValidationError('bad', ['a', 'b']);
const SAMPLES: Record<string, () => errors.PPEError> = {
  PPEError: () => new errors.PPEError('m', 'C'),
  RuleConflictError: () => new errors.RuleConflictError(['a', 'b'], 1),
  ModelNotFoundError: () => new errors.ModelNotFoundError('m'),
  DSLNotFoundError: () => new errors.DSLNotFoundError('d'),
  SnapshotFailureError: () => new errors.SnapshotFailureError(new Error('store down')),
  DSLTimeoutError: () => new errors.DSLTimeoutError('d', 5),
  DSLEvaluationError: () => new errors.DSLEvaluationError('d', new Error('x')),
  PipelineTimeoutError: () => new errors.PipelineTimeoutError(5),
  ValidationError: () => nested,
  DuplicateRequestError: () => new errors.DuplicateRequestError('r'),
  EngineLimitError: () => new errors.EngineLimitError('maxRules', 1, 2, '/rules', 'model:m'),
  PluginHookError: () => new errors.PluginHookError('p', 'beforeEvaluate', new Error('x')),
  FrozenViewWriteError: () => new errors.FrozenViewWriteError('k'),
  ExceptionPrecedenceError: () => new errors.ExceptionPrecedenceError('a', 'b', 'x', 'y'),
  OutputNotFiniteError: () => new errors.OutputNotFiniteError('o', ['a@1']),
  DecimalPrecisionError: () => new errors.DecimalPrecisionError('o', 1000),
  InvalidModelError: () => new errors.InvalidModelError('m', ['i1']),
  HookTimeoutError: () => new errors.HookTimeoutError('p', 'afterEvaluate', 5),
  UnexpectedEngineError: () => new errors.UnexpectedEngineError(new Error('x')),
};

function assertDeepFrozen(value: unknown, path: string, seen = new Set<unknown>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value), `${path} is frozen`).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d !== undefined && 'value' in d) assertDeepFrozen(d.value, `${path}.${String(key)}`, seen);
  }
}

describe('AG1: every error class exported is frozen at creation', () => {
  it('has a sample for every exported error class', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(errors).sort());
  });

  for (const [name, make] of Object.entries(SAMPLES)) {
    it(`${name} is deeply frozen`, () => {
      const e = make();
      assertDeepFrozen(e, name);
      expect(() => {
        (e as { message: string }).message = 'changed';
      }).toThrow(TypeError);
    });
  }

  it('an attributed limit is frozen', () => {
    const e = attributeLimit(new errors.EngineLimitError('maxRules', 1, 2), 'dsl:x');
    assertDeepFrozen(e, 'attributed');
    expect(e.source).toBe('dsl:x');
  });

  it('SnapshotFailureError keeps the adapter error as bounded text only', () => {
    const original = new Error('x'.repeat(5000));
    const e = new errors.SnapshotFailureError(original);
    expect(e.cause).not.toBe(original);
    expect(typeof (e.cause as { message: unknown }).message).toBe('string');
    expect(((e.cause as { message: string }).message).length).toBeLessThanOrEqual(1100);
    assertDeepFrozen(e, 'snapshot');
  });

  it('an error that leaves evaluate is frozen, with its onErrorFailures', async () => {
    const engine = new PPEEngine({ models: [], dsls: [],
      plugins: [
        {
          name: 'p',
          version: '1.0.0',
          onInit() {},
          onError() {
            throw new Error('boom');
          },
        },
      ],
    });
    const caught = await engine.evaluate({ rules: [], input: { requestId: 'r', data: {}, meta: {} } }).catch((e: unknown) => e);
    assertDeepFrozen(caught, 'caught');
    assertDeepFrozen((caught as errors.PPEError).onErrorFailures, 'onErrorFailures');
  });
});
