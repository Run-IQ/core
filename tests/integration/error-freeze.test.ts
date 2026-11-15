import { describe, it, expect } from 'vitest';
import * as errors from '../../src/errors/index.js';
import { attributeLimit } from '../../src/errors/EngineLimitError.js';
import { makeInput, makeRule, StubModel, InMemorySnapshotAdapter } from '../helpers.js';
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
  EngineConfigError: () => new errors.EngineConfigError('/strict', 'must be true or false'),
  ChecksumMismatchError: () => new errors.ChecksumMismatchError('a@1', '/rules/0'),
  CallbackError: () => new errors.CallbackError('onSnapshotError', new Error('x')),
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
    expect((e.cause as { message: string }).message.length).toBeLessThanOrEqual(1100);
    assertDeepFrozen(e, 'snapshot');
  });

  it('an error that leaves evaluate is frozen, with its onErrorFailures', async () => {
    const engine = new PPEEngine({
      dsls: [],
      strict: false,
      plugins: [
        {
          name: 'p',
          version: '1.0.0',
          onInit() {},
          beforeEvaluate() {
            throw new Error('real');
          },
          onError() {
            throw new Error('boom');
          },
        },
      ],
    });
    const caught = await engine.evaluate([], makeInput()).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(errors.PluginHookError);
    expect((caught as errors.PPEError).onErrorFailures).toHaveLength(1);
    assertDeepFrozen(caught, 'caught');
    assertDeepFrozen((caught as errors.PPEError).onErrorFailures, 'onErrorFailures');
  });
});

/**
 * AH1: not only the exported classes: every error that LEAVES the engine, by every throw site the
 * caller can reach, is an instance of an engine class, deep-frozen, holds no object of the caller
 * or of an adapter, and carries the failures of `onError` when it came out of `evaluate`.
 */
describe('AH1: every error the caller receives, by each throw site', () => {
  const failingOnError = (name = 'watch'): never =>
    ({
      name,
      version: '1.0.0',
      onInit: (context: { modelRegistry: { register(model: StubModel): void } }) =>
        context.modelRegistry.register(new StubModel('tax', 10)),
      onError: () => {
        throw new Error(`${name} onError failed`);
      },
    }) as never;

  const caught = async (run: () => unknown): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  const sites: Array<[string, () => Promise<unknown>, string]> = [
    [
      "a checksum mismatch with onChecksumMismatch: 'throw'",
      async () => {
        const bad = { ...makeRule({ id: 'tax', model: 'tax' }), checksum: 'f'.repeat(64) };
        return caught(() =>
          new PPEEngine({
            plugins: [failingOnError()],
            dsls: [],
            strict: false,
            onChecksumMismatch: 'throw',
          }).evaluate([bad], makeInput()),
        );
      },
      'ChecksumMismatchError',
    ],
    [
      'an adapter whose exists rejects',
      async () => {
        const secret = { token: 'hunter2' };
        const adapter = new InMemorySnapshotAdapter();
        adapter.exists = () => Promise.reject(Object.assign(new Error('exists down'), { secret }));
        const error = await caught(() =>
          new PPEEngine({
            plugins: [failingOnError()],
            dsls: [],
            snapshot: adapter,
            strict: false,
          }).evaluate([], makeInput()),
        );
        // No object of the adapter is reachable from what the caller holds.
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('hunter2');
        expect((error as { cause?: unknown }).cause).toEqual({
          name: 'Error',
          message: 'exists down',
        });
        return error;
      },
      'SnapshotFailureError',
    ],
    [
      'an onSnapshotError callback that throws',
      async () => {
        const adapter = new InMemorySnapshotAdapter();
        adapter.shouldFail = true;
        const own = Object.assign(new Error('callback failed'), { secret: { token: 'hunter2' } });
        const error = await caught(() =>
          new PPEEngine({
            plugins: [failingOnError()],
            dsls: [],
            snapshot: adapter,
            strict: false,
            onSnapshotError: () => {
              throw own;
            },
          }).evaluate([makeRule({ id: 'tax', model: 'tax' })], makeInput()),
        );
        expect(error).not.toBe(own);
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('hunter2');
        return error;
      },
      'CallbackError',
    ],
  ];

  for (const [label, run, className] of sites) {
    it(`${label}: a frozen ${className}, with onErrorFailures`, async () => {
      const error = await run();
      expect(error, 'nothing was thrown').toBeDefined();
      expect(error).toBeInstanceOf(errors.PPEError);
      expect((error as Error).constructor.name).toBe(className);
      assertDeepFrozen(error, className);
      const failures = (error as errors.PPEError).onErrorFailures;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ plugin: 'watch', hook: 'onError' });
    });
  }

  it('the checksum mismatch names the rule and its place in the rules given', async () => {
    const good = makeRule({ id: 'ok', model: 'tax' });
    const bad = { ...makeRule({ id: 'tax', model: 'tax' }), checksum: 'f'.repeat(64) };
    const error = await caught(() =>
      new PPEEngine({
        plugins: [failingOnError()],
        dsls: [],
        strict: false,
        onChecksumMismatch: 'throw',
      }).evaluate([good, bad], makeInput()),
    );
    expect(error).toMatchObject({ rule: 'tax@1', pointer: '/rules/1' });
  });

  const construction: Array<[string, () => PPEEngine, string]> = [
    [
      'a duplicate plugin',
      () =>
        new PPEEngine({
          plugins: [failingOnError('same'), failingOnError('same')],
          dsls: [],
        }),
      '/plugins/1',
    ],
    [
      'a duplicate DSL',
      () => {
        const dsl = { dsl: 'one', version: '1.0.0', evaluate: () => true };
        return new PPEEngine({ plugins: [], dsls: [dsl, { ...dsl }] });
      },
      '/dsls/1',
    ],
    [
      'a plugin whose onInit is not a function',
      () =>
        new PPEEngine({
          plugins: [{ name: 'p', version: '1.0.0', onInit: 'nope' } as never],
          dsls: [],
        }),
      '/plugins/0',
    ],
    [
      'a DSL whose evaluate is not a function',
      () =>
        new PPEEngine({
          plugins: [],
          dsls: [{ dsl: 'd', version: '1.0.0', evaluate: 1 } as never],
        }),
      '/dsls/0',
    ],
    [
      'a plugin that is not an object',
      () => new PPEEngine({ plugins: [null as never], dsls: [] }),
      '/plugins/0',
    ],
  ];
  for (const [label, build, path] of construction) {
    it(`${label} is a frozen EngineConfigError naming ${path}`, () => {
      let error: unknown;
      try {
        build();
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(errors.EngineConfigError);
      expect(error).toBeInstanceOf(errors.PPEError);
      expect((error as errors.EngineConfigError).path).toBe(path);
      assertDeepFrozen(error, 'config');
    });
  }
});
