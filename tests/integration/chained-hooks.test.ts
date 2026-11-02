import { describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext, BeforeEvaluateResult } from '../../src/types/plugin.js';
import type { EvaluationInput } from '../../src/types/input.js';
import type { Rule } from '../../src/types/rule.js';
import type { UnsealedResult } from '../../src/types/result.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import {
  makeRule,
  makeInput,
  StubModel,
  StubDSL,
  ValueModel,
  InMemorySnapshotAdapter,
  expectSameFailure,
} from '../helpers.js';
// Imported from the package entry: both errors are public.
import {
  HookTimeoutError,
  PPEError,
  PluginHookError,
  UnexpectedEngineError,
} from '../../src/index.js';

class EnrichingPlugin implements PPEPlugin {
  readonly name: string;
  readonly version = '1.0.0';
  private readonly enrichKey: string;
  private readonly enrichValue: unknown;

  constructor(name: string, enrichKey: string, enrichValue: unknown) {
    this.name = name;
    this.enrichKey = enrichKey;
    this.enrichValue = enrichValue;
  }

  onInit(_context: PluginContext): void {
    // No models to register
  }

  beforeEvaluate(input: EvaluationInput, rules: ReadonlyArray<Rule>): BeforeEvaluateResult {
    return {
      input: {
        ...input,
        data: { ...input.data, [this.enrichKey]: this.enrichValue },
      },
      rules,
    };
  }
}

describe('Chained beforeEvaluate hooks', () => {
  it('second plugin sees modifications from first plugin', async () => {
    const model = new StubModel('M', 100);

    // First plugin adds 'enrichedA' to input.data
    const pluginA = new EnrichingPlugin('plugin-a', 'enrichedA', 'fromA');

    // Second plugin adds 'enrichedB' to input.data
    const pluginB = new EnrichingPlugin('plugin-b', 'enrichedB', 'fromB');

    // We need a model-registering plugin — use a third plugin for the model
    const modelPlugin: PPEPlugin = {
      name: 'model-host',
      version: '1.0.0',
      onInit(context: PluginContext): void {
        context.modelRegistry.register(model);
      },
    };

    const engine = new PPEEngine({
      plugins: [modelPlugin, pluginA, pluginB],
      dsls: [],
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());

    // Both plugins' modifications should be present
    expect(result.value).toBe(100);
    expect(result.appliedRules).toHaveLength(1);
    expect(result.pluginVersions['plugin-a']).toBe('1.0.0');
    expect(result.pluginVersions['plugin-b']).toBe('1.0.0');
  });

  it('chains data through multiple beforeEvaluate hooks sequentially', async () => {
    let capturedData: Record<string, unknown> | undefined;

    const pluginA: PPEPlugin = {
      name: 'adder-a',
      version: '1.0.0',
      onInit(): void {
        // no-op
      },
      beforeEvaluate(input: EvaluationInput, rules: ReadonlyArray<Rule>): BeforeEvaluateResult {
        return {
          input: { ...input, data: { ...input.data, fromA: true } },
          rules,
        };
      },
    };

    const pluginB: PPEPlugin = {
      name: 'adder-b',
      version: '1.0.0',
      onInit(): void {
        // no-op
      },
      beforeEvaluate(input: EvaluationInput, rules: ReadonlyArray<Rule>): BeforeEvaluateResult {
        // Capture what pluginB receives — should include fromA
        capturedData = { ...input.data };
        return {
          input: { ...input, data: { ...input.data, fromB: true } },
          rules,
        };
      },
    };

    const model = new StubModel('M', 50);
    const modelPlugin: PPEPlugin = {
      name: 'model-host',
      version: '1.0.0',
      onInit(context: PluginContext): void {
        context.modelRegistry.register(model);
      },
    };

    const engine = new PPEEngine({
      plugins: [modelPlugin, pluginA, pluginB],
      dsls: [],
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    await engine.evaluate(rules, makeInput());

    // pluginB should have received the enrichment from pluginA
    expect(capturedData).toBeDefined();
    expect(capturedData!['fromA']).toBe(true);
  });
});

/** A plugin hosting model M (returns 100) with the given hooks. */
function pluginWith(name: string, hooks: Partial<PPEPlugin> = {}): PPEPlugin {
  return {
    name,
    version: '1.0.0',
    onInit(): void {
      // no-op
    },
    ...hooks,
  };
}

/** What `evaluate` rejects with, or `undefined` when it resolves. */
async function failure(engine: PPEEngine, rules: Rule[]): Promise<unknown> {
  return engine.evaluate(rules, makeInput()).then(
    () => undefined,
    (error: unknown) => error,
  );
}

function engineWith(
  plugins: PPEPlugin[],
  dsls: DSLEvaluator[] = [],
  snapshot?: InMemorySnapshotAdapter,
): PPEEngine {
  const host: PPEPlugin = {
    name: 'model-host',
    version: '1.0.0',
    onInit(context: PluginContext): void {
      context.modelRegistry.register(new StubModel('M', 100));
    },
  };
  return new PPEEngine({
    plugins: [host, ...plugins],
    dsls,
    strict: false,
    ...(snapshot === undefined ? {} : { snapshot }),
  });
}

/**
 * The result as a careless plugin sees it at runtime: the readonly types forbid these writes,
 * JavaScript does not.
 */
interface MutableResult {
  value: unknown;
  appliedRules: { id: string; model: string; params: Record<string, unknown> }[];
  outputs: Record<string, { value: unknown; contributors: string[] }>;
}

describe('Hook errors', () => {
  it('fails the evaluation when a beforeEvaluate throws, with or without an onError', async () => {
    const thrown = new Error('boom');
    const broken = pluginWith('broken', {
      beforeEvaluate(): BeforeEvaluateResult {
        throw thrown;
      },
    });
    const error = await failure(engineWith([broken]), [makeRule({ id: 'r1', model: 'M' })]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({
      code: 'PLUGIN_HOOK',
      plugin: 'broken',
      hook: 'beforeEvaluate',
      message: 'plugin broken beforeEvaluate failed: boom',
    });
    expect((error as PluginHookError).cause).toBe(thrown);
  });

  it('calls onError with the PluginHookError and the input given to evaluate', async () => {
    const thrown = new Error('boom');
    const onError = vi.fn();
    const broken = pluginWith('broken', {
      beforeEvaluate(): BeforeEvaluateResult {
        throw thrown;
      },
      onError,
    });
    const input = makeInput();
    const error = await engineWith([broken])
      .evaluate([makeRule({ id: 'r1', model: 'M' })], input)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expectSameFailure(onError.mock.calls[0]?.[0], error);
    expect(onError.mock.calls[0]?.[1]).toBe(input);
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error as PluginHookError).cause).toBe(thrown);
  });

  it('a failing onError does not hide the hook failure from the caller', async () => {
    const broken = pluginWith('broken', {
      afterEvaluate(): UnsealedResult {
        throw new Error('boom');
      },
      onError(): void {
        throw new Error('onError crash');
      },
    });
    const error = await failure(engineWith([broken]), [makeRule({ id: 'r1', model: 'M' })]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({
      hook: 'afterEvaluate',
      message: 'plugin broken afterEvaluate failed: boom',
    });
  });

  it('orders the diagnostics the engine accepts: engine first, then the plugins by registration', async () => {
    const facts: DSLEvaluator = {
      dsl: 'facts',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: () => {
        throw new Error('cannot parse');
      },
    };
    // Each plugin adds a rule before; afterEvaluate leaves the decision as it is.
    const adding = (name: string): PPEPlugin =>
      pluginWith(name, {
        beforeEvaluate: (input, rules) => ({
          input,
          rules: [...rules, makeRule({ id: `${name}-rule`, model: 'M' })],
        }),
        afterEvaluate: (_input, result) => result,
      });
    const result = await engineWith([adding('p1'), adding('p2')], [facts]).evaluate(
      [makeRule({ id: 'r1', model: 'M', condition: { dsl: 'facts', value: 'x' } })],
      makeInput(),
    );
    expect(result.diagnostics.map((d) => [d.source, d.plugin, d.hook, d.message])).toEqual([
      ['engine', undefined, undefined, 'listVariables of facts for r1@1 failed: cannot parse'],
      ['hook', 'p1', 'beforeEvaluate', 'plugin p1 added rules: p1-rule@1'],
      ['hook', 'p2', 'beforeEvaluate', 'plugin p2 added rules: p2-rule@1'],
    ]);
  });
});

describe('Plugin state', () => {
  it('keeps the state returned by beforeEvaluate and shows it to afterEvaluate', async () => {
    let seen: unknown;
    const stateful = pluginWith('stateful', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        return { input, rules, state: { a: 1 } };
      },
      afterEvaluate(_input, result): UnsealedResult {
        seen = result.pluginState['stateful'];
        return result;
      },
    });
    const result = await engineWith([stateful]).evaluate(
      [makeRule({ id: 'r1', model: 'M' })],
      makeInput(),
    );
    expect(result.pluginState).toEqual({ stateful: { a: 1 } });
    expect(seen).toEqual({ a: 1 });
    expect(result.diagnostics).toEqual([]);
  });

  it('fails the evaluation for a state that is not JSON, naming the path', async () => {
    const valid = pluginWith('valid', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        return { input, rules, state: { when: null } };
      },
    });
    const dated = pluginWith('dated', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        const result: BeforeEvaluateResult = { input, rules };
        // The type forbids a Date in the state; a plugin can still return one at runtime.
        Object.defineProperty(result, 'state', {
          enumerable: true,
          value: { list: [1, new Date(0)] },
        });
        return result;
      },
    });
    let reached = false;
    const reader = pluginWith('reader', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        reached = true;
        return { input, rules };
      },
    });
    const error = await failure(engineWith([valid, dated, reader]), [
      makeRule({ id: 'r1', model: 'M' }),
    ]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: 'dated', hook: 'beforeEvaluate' });
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin dated beforeEvaluate returned a state that is not JSON at $.list[1] (Date)',
    });
    expect(reached).toBe(false);
  });
});

describe('afterEvaluate cannot change the decision', () => {
  const rules1 = (): Rule[] => [makeRule({ id: 'r1', model: 'M' })];

  /** The failure is a PluginHookError of the plugin, naming exactly the fields it changed. */
  async function expectChanged(
    plugin: PPEPlugin,
    fields: string,
    plugins: PPEPlugin[] = [],
    engine = engineWith([...plugins, plugin]),
    rules = rules1(),
  ): Promise<void> {
    const error = await failure(engine, rules);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({ plugin: plugin.name, hook: 'afterEvaluate' });
    expect((error as PluginHookError).cause).toMatchObject({
      message: `plugin ${plugin.name} afterEvaluate changed the decision: ${fields}`,
    });
  }

  it('fails for a rewritten value', async () => {
    await expectChanged(
      pluginWith('fiscal', { afterEvaluate: (_input, result) => ({ ...result, value: 0 }) }),
      'value',
    );
  });

  it('fails for rules added to, removed from or moved between the applied and skipped lists', async () => {
    const pseudo = makeRule({ id: 'SC', model: 'META_SHORT_CIRCUIT', priority: 9999 });
    const error = await failure(
      engineWith(
        [
          pluginWith('fiscal', {
            afterEvaluate(_input, result): UnsealedResult {
              const r2 = result.appliedRules.find((r) => r.id === 'r2')!;
              return {
                ...result,
                appliedRules: [...result.appliedRules.filter((r) => r !== r2), pseudo],
                skippedRules: [{ rule: r2, reason: 'RULE_CONFLICT' }],
              };
            },
          }),
        ],
        [new StubDSL('never', false)],
      ),
      [
        makeRule({ id: 'r1', model: 'M' }),
        makeRule({ id: 'r2', model: 'M' }),
        makeRule({ id: 'gone', model: 'M', condition: { dsl: 'never', value: null } }),
      ],
    );
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin fiscal afterEvaluate changed the decision: appliedRules, skippedRules',
    });
  });

  it('fails for rules removed without a skip', async () => {
    await expectChanged(
      pluginWith('fiscal', {
        afterEvaluate: (_input, result) => ({ ...result, appliedRules: [] }),
      }),
      'appliedRules',
    );
  });

  it('fails for a changed breakdown or trace', async () => {
    await expectChanged(
      pluginWith('fiscal', {
        afterEvaluate: (_input, result) => ({ ...result, breakdown: [] }),
      }),
      'breakdown',
    );
    await expectChanged(
      pluginWith('fiscal', {
        afterEvaluate: (_input, result) => ({ ...result, trace: { ...result.trace, steps: [] } }),
      }),
      'trace',
    );
  });

  it('fails for a field the plugin adds, or one it drops', async () => {
    await expectChanged(
      pluginWith('fiscal', {
        afterEvaluate: (_input, result) => ({ ...result, extra: 1 }) as UnsealedResult,
      }),
      'extra',
    );
    await expectChanged(
      pluginWith('fiscal', {
        afterEvaluate(_input, result): UnsealedResult {
          const rest: Partial<Record<keyof UnsealedResult, unknown>> = { ...result };
          delete rest.timestamp;
          return rest as UnsealedResult;
        },
      }),
      'timestamp',
    );
  });

  it('fails for a direct change of outputs, however it is written', async () => {
    const RISK = { type: 'string', combine: 'highestPriority' } as const;
    const host: PPEPlugin = {
      name: 'model-host',
      version: '1.0.0',
      onInit(context: PluginContext): void {
        context.modelRegistry.register(new StubModel('M', 100));
        context.modelRegistry.register(new ValueModel('RISK', RISK, { k: 'low' }));
      },
    };
    const rules = (): Rule[] => [
      makeRule({ id: 'r1', model: 'M' }),
      makeRule({ id: 'k', model: 'RISK', output: 'risk' }),
    ];
    const run = async (plugin: PPEPlugin, fields: string): Promise<void> => {
      const engine = new PPEEngine({ plugins: [host, plugin], dsls: [], strict: false });
      const error = await failure(engine, rules());
      expect((error as PluginHookError).cause).toMatchObject({
        message: `plugin ${plugin.name} afterEvaluate changed the decision: ${fields}`,
      });
    };
    await run(
      pluginWith('sneaky', {
        afterEvaluate(_input, result): UnsealedResult {
          const value = { ...result.outputs['value']!, value: 7 };
          return { ...result, outputs: { ...result.outputs, value } };
        },
      }),
      'outputs',
    );
    await run(
      pluginWith('sneaky', {
        afterEvaluate(_input, result): UnsealedResult {
          const kept = Object.fromEntries(
            Object.entries(result.outputs).filter(([name]) => name !== 'risk'),
          );
          return {
            ...result,
            outputs: { ...kept, extra: { ...result.outputs['value']!, name: 'extra' } },
          };
        },
      }),
      'outputs',
    );
    await run(
      pluginWith('tidy', {
        afterEvaluate(_input, result): UnsealedResult {
          const value = { ...result.outputs['value']!, value: 0 };
          return { ...result, value: 0, outputs: { ...result.outputs, value } };
        },
      }),
      'outputs, value',
    );
  });

  it('hands plugins a copy: a plugin that writes into it changes nothing, and the evaluation fails', async () => {
    const rule = makeRule({ id: 'r1', model: 'M', params: { rate: 1 } });
    const careless = pluginWith('careless', {
      afterEvaluate(_input, result): UnsealedResult {
        // A careless plugin writing through the readonly types.
        const writable: MutableResult = result as unknown as MutableResult;
        writable.value = 0;
        writable.appliedRules.push({ id: 'SC', model: 'META_SHORT_CIRCUIT', params: {} });
        writable.appliedRules[0]!.params['rate'] = 2;
        writable.outputs['value']!.contributors.push('ghost');
        return result;
      },
    });
    const adapter = new InMemorySnapshotAdapter();
    const engine = engineWith([careless], [], adapter);
    await engine.evaluate([rule], makeInput()).then(
      () => expect.unreachable('should have failed'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(PluginHookError);
        // The result it was handed refuses writes: the first one throws a dedicated error.
        expect(((error as PluginHookError).cause as Error).name).toBe('FrozenViewWriteError');
      },
    );
    expect(rule.params).toEqual({ rate: 1 });
    expect(await adapter.exists(makeInput().requestId)).toBe(false);
  });

  it('accepts a result that leaves the decision as it is, and sets its meta and its own pluginState', async () => {
    const annotating = pluginWith('fiscal', {
      afterEvaluate: (_input, result) => ({
        ...result,
        meta: { note: 'checked' },
        pluginState: { ...result.pluginState, fiscal: { regime: 'normal' } },
      }),
    });
    const plain = await engineWith([]).evaluate(rules1(), makeInput());
    const result = await engineWith([annotating]).evaluate(rules1(), makeInput());
    expect(result.meta).toEqual({ note: 'checked' });
    expect(result.pluginState).toEqual({ fiscal: { regime: 'normal' } });
    expect(result.value).toBe(plain.value);
    expect(result.outputs).toEqual(plain.outputs);
    expect(result.appliedRules).toEqual(plain.appliedRules);
    expect(result.diagnostics).toEqual([]);
  });

  it("fails for a change to another plugin's pluginState, or its removal", async () => {
    const keeper = pluginWith('keeper', {
      beforeEvaluate: (input, rules) => ({ input, rules, state: 1 }),
    });
    await expectChanged(
      pluginWith('fiscal', {
        afterEvaluate: (_input, result) => ({
          ...result,
          pluginState: { ...result.pluginState, keeper: 2 },
        }),
      }),
      'pluginState',
      [keeper],
    );
    await expectChanged(
      pluginWith('fiscal', {
        afterEvaluate: (_input, result) => ({ ...result, pluginState: {} }),
      }),
      'pluginState',
      [keeper],
    );
  });

  it('fails for a pluginState entry of its own that is not JSON', async () => {
    const error = await failure(
      engineWith([
        pluginWith('fiscal', {
          afterEvaluate: (_input, result) =>
            ({ ...result, pluginState: { fiscal: { at: new Date(0) } } }) as never,
        }),
      ]),
      rules1(),
    );
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin fiscal afterEvaluate returned a pluginState that is not JSON at $.at (Date)',
    });
  });

  it('fails for a meta that is not an object', async () => {
    const error = await failure(
      engineWith([
        pluginWith('fiscal', {
          afterEvaluate: (_input, result) => ({ ...result, meta: 5 }) as never,
        }),
      ]),
      rules1(),
    );
    expect((error as PluginHookError).cause).toMatchObject({
      message: 'plugin fiscal afterEvaluate returned a malformed meta',
    });
  });
});

describe('Hook timeouts and onError typing', () => {
  it('fails the evaluation for a hook timeout: the cause is a HookTimeoutError naming the plugin and hook', async () => {
    const onError = vi.fn();
    const slow = pluginWith('slow', {
      beforeEvaluate: (input, rules) =>
        new Promise<BeforeEvaluateResult>((resolve) =>
          setTimeout(() => resolve({ input, rules }), 200),
        ),
      onError,
    });
    const host: PPEPlugin = {
      name: 'model-host',
      version: '1.0.0',
      onInit: (context) => context.modelRegistry.register(new StubModel('M', 100)),
    };
    const engine = new PPEEngine({
      plugins: [host, slow],
      dsls: [],
      strict: false,
      timeout: { hook: 20 },
    });
    const error = await failure(engine, [makeRule({ id: 'r1', model: 'M' })]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({
      code: 'PLUGIN_HOOK',
      plugin: 'slow',
      hook: 'beforeEvaluate',
      message:
        'plugin slow beforeEvaluate failed: plugin slow hook beforeEvaluate timed out after 20 ms',
    });
    const cause = (error as PluginHookError).cause;
    expect(cause).toBeInstanceOf(HookTimeoutError);
    expect(cause).toMatchObject({
      code: 'HOOK_TIMEOUT',
      pluginName: 'slow',
      hook: 'beforeEvaluate',
      timeoutMs: 20,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expectSameFailure(onError.mock.calls[0]?.[0], error);
  });

  it('fails the evaluation for a non-PPEError hook error, keeping the original as cause', async () => {
    const thrown = new TypeError('bad shape');
    const onError = vi.fn();
    const broken = pluginWith('broken', {
      afterEvaluate(): UnsealedResult {
        throw thrown;
      },
      onError,
    });
    const error = await failure(engineWith([broken]), [makeRule({ id: 'r1', model: 'M' })]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error as PluginHookError).cause).toBe(thrown);
    // The PluginHookError is a PPEError: onError gets it as it is, not wrapped.
    expectSameFailure(onError.mock.calls[0]?.[0], error);
  });

  it('keeps a PPEError a hook throws as the cause of the PluginHookError', async () => {
    const thrown = new PPEError('known', 'KNOWN');
    const onError = vi.fn();
    const broken = pluginWith('broken', {
      beforeEvaluate(): BeforeEvaluateResult {
        throw thrown;
      },
      onError,
    });
    const error = await failure(engineWith([broken]), [makeRule({ id: 'r1', model: 'M' })]);
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error as PluginHookError).cause).toBe(thrown);
    expect(onError).toHaveBeenCalledTimes(1);
    expectSameFailure(onError.mock.calls[0]?.[0], error);
  });

  it('gives onError a wrapped engine error while the caller gets the original', async () => {
    const thrown = new RangeError('model crash');
    const onError = vi.fn();
    const crashing: PPEPlugin = {
      name: 'crashing',
      version: '1.0.0',
      onInit: (context) =>
        context.modelRegistry.register({
          name: 'CRASH',
          version: '1.0.0',
          validateParams: () => ({ valid: true }),
          calculate: () => {
            throw thrown;
          },
        }),
      onError,
    };
    const engine = new PPEEngine({ plugins: [crashing], dsls: [], strict: false });
    const outcome = engine.evaluate([makeRule({ id: 'r1', model: 'CRASH' })], makeInput());
    await expect(outcome).rejects.toBe(thrown);
    expect(onError).toHaveBeenCalledTimes(1);
    const error: unknown = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    // A frozen copy: the cause is a copy of what was thrown, never the object the caller gets.
    expect(error).toMatchObject({ code: 'UNEXPECTED', message: 'model crash' });
    expect((error as { cause: unknown }).cause).not.toBe(thrown);
    expect((error as { cause: Error }).cause.message).toBe('model crash');
  });
});
