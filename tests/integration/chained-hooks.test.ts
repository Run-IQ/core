import { describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext, BeforeEvaluateResult } from '../../src/types/plugin.js';
import type { EvaluationInput } from '../../src/types/input.js';
import type { Rule } from '../../src/types/rule.js';
import type { EvaluationResult } from '../../src/types/result.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import { makeRule, makeInput, StubModel, StubDSL, ValueModel } from '../helpers.js';
// Imported from the package entry: both errors are public.
import { HookTimeoutError, PPEError, UnexpectedEngineError } from '../../src/index.js';

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

function engineWith(plugins: PPEPlugin[], dsls: DSLEvaluator[] = []): PPEEngine {
  const host: PPEPlugin = {
    name: 'model-host',
    version: '1.0.0',
    onInit(context: PluginContext): void {
      context.modelRegistry.register(new StubModel('M', 100));
    },
  };
  return new PPEEngine({ plugins: [host, ...plugins], dsls, strict: false });
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
  it('reports a beforeEvaluate error without onError as a diagnostic and goes on', async () => {
    const broken = pluginWith('broken', {
      beforeEvaluate(): BeforeEvaluateResult {
        throw new Error('boom');
      },
    });
    const result = await engineWith([broken]).evaluate(
      [makeRule({ id: 'r1', model: 'M' })],
      makeInput(),
    );
    expect(result.value).toBe(100);
    expect(result.diagnostics).toEqual([
      { source: 'hook', plugin: 'broken', hook: 'beforeEvaluate', message: 'boom' },
    ]);
  });

  it('calls onError and still reports the diagnostic', async () => {
    const thrown = new Error('boom');
    const onError = vi.fn();
    const broken = pluginWith('broken', {
      beforeEvaluate(): BeforeEvaluateResult {
        throw thrown;
      },
      onError,
    });
    const input = makeInput();
    const result = await engineWith([broken]).evaluate([makeRule({ id: 'r1', model: 'M' })], input);
    expect(onError).toHaveBeenCalledTimes(1);
    // A plain Error reaches onError wrapped (R28), with the input the hook received.
    expect(onError).toHaveBeenCalledWith(expect.any(UnexpectedEngineError), input);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'UNEXPECTED', cause: thrown });
    expect(result.diagnostics).toEqual([
      { source: 'hook', plugin: 'broken', hook: 'beforeEvaluate', message: 'boom' },
    ]);
  });

  it('reports a failing onError as a second diagnostic', async () => {
    const broken = pluginWith('broken', {
      afterEvaluate(): EvaluationResult {
        throw new Error('boom');
      },
      onError(): void {
        throw new Error('onError crash');
      },
    });
    const result = await engineWith([broken]).evaluate(
      [makeRule({ id: 'r1', model: 'M' })],
      makeInput(),
    );
    expect(result.value).toBe(100);
    expect(result.diagnostics).toEqual([
      { source: 'hook', plugin: 'broken', hook: 'afterEvaluate', message: 'boom' },
      {
        source: 'hook',
        plugin: 'broken',
        hook: 'afterEvaluate',
        message: 'onError failed: onError crash',
      },
    ]);
  });

  it('orders diagnostics: engine first, then beforeEvaluate, then afterEvaluate, by plugin', async () => {
    const facts: DSLEvaluator = {
      dsl: 'facts',
      version: '1.0.0',
      evaluate: () => true,
      listVariables: () => {
        throw new Error('cannot parse');
      },
    };
    const failing = (name: string): PPEPlugin =>
      pluginWith(name, {
        beforeEvaluate(): BeforeEvaluateResult {
          throw new Error(`${name} before`);
        },
        afterEvaluate(): EvaluationResult {
          throw new Error(`${name} after`);
        },
      });
    const result = await engineWith([failing('p1'), failing('p2')], [facts]).evaluate(
      [makeRule({ id: 'r1', model: 'M', condition: { dsl: 'facts', value: 'x' } })],
      makeInput(),
    );
    expect(result.diagnostics.map((d) => [d.source, d.plugin, d.hook, d.message])).toEqual([
      ['engine', undefined, undefined, 'listVariables failed for r1@1 (facts): cannot parse'],
      ['hook', 'p1', 'beforeEvaluate', 'p1 before'],
      ['hook', 'p2', 'beforeEvaluate', 'p2 before'],
      ['hook', 'p1', 'afterEvaluate', 'p1 after'],
      ['hook', 'p2', 'afterEvaluate', 'p2 after'],
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
      afterEvaluate(_input, result): EvaluationResult {
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

  it('drops a non-JSON state with a diagnostic naming the path, and keeps the rest', async () => {
    const valid = pluginWith('valid', {
      beforeEvaluate(input): BeforeEvaluateResult {
        return { input, rules: [], state: { when: null } };
      },
    });
    const dated = pluginWith('dated', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        const result: BeforeEvaluateResult = {
          input: { ...input, data: { ...input.data, enriched: true } },
          rules,
        };
        // The type forbids a Date in the state; a plugin can still return one at runtime.
        Object.defineProperty(result, 'state', {
          enumerable: true,
          value: { list: [1, new Date(0)] },
        });
        return result;
      },
    });
    let seen: unknown;
    const reader = pluginWith('reader', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        seen = input.data['enriched'];
        return { input, rules };
      },
    });
    const result = await engineWith([valid, dated, reader]).evaluate(
      [makeRule({ id: 'r1', model: 'M' })],
      makeInput(),
    );
    expect(result.pluginState).toEqual({ valid: { when: null } });
    expect(seen).toBe(true);
    expect(result.appliedRules).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        source: 'hook',
        plugin: 'dated',
        hook: 'beforeEvaluate',
        message: 'state is not JSON at $.list[1] (Date): state dropped',
      },
    ]);
  });
});

describe('afterEvaluate transitions', () => {
  it('keeps outputs.value in sync when a plugin rewrites value, and says so', async () => {
    const rewriting = pluginWith('fiscal', {
      afterEvaluate(_input, result): EvaluationResult {
        return { ...result, value: 0 };
      },
    });
    const result = await engineWith([rewriting]).evaluate(
      [makeRule({ id: 'r1', model: 'M' })],
      makeInput(),
    );
    expect(result.value).toBe(0);
    expect(result.outputs['value']).toEqual({
      name: 'value',
      type: 'number',
      combine: 'sum',
      value: 0,
      contributors: ['r1'],
    });
    expect(result.diagnostics).toEqual([
      {
        source: 'hook',
        plugin: 'fiscal',
        hook: 'afterEvaluate',
        message: 'plugin fiscal rewrote output value from 100 to 0',
      },
    ]);
  });

  it('names the rules a plugin adds to or removes from the applied and skipped lists', async () => {
    const pseudo = makeRule({ id: 'SC', model: 'META_SHORT_CIRCUIT', priority: 9999 });
    const rewriting = pluginWith('fiscal', {
      afterEvaluate(_input, result): EvaluationResult {
        const r2 = result.appliedRules.find((r) => r.id === 'r2')!;
        return {
          ...result,
          appliedRules: [...result.appliedRules.filter((r) => r !== r2), pseudo],
          skippedRules: [{ rule: r2, reason: 'RULE_CONFLICT' }],
        };
      },
    });
    const result = await engineWith([rewriting], [new StubDSL('never', false)]).evaluate(
      [
        makeRule({ id: 'r1', model: 'M' }),
        makeRule({ id: 'r2', model: 'M' }),
        makeRule({ id: 'gone', model: 'M', condition: { dsl: 'never', value: null } }),
      ],
      makeInput(),
    );
    expect(result.appliedRules.map((r) => r.id)).toEqual(['r1', 'SC']);
    expect(result.diagnostics.map((d) => [d.source, d.plugin, d.hook, d.message])).toEqual([
      ['hook', 'fiscal', 'afterEvaluate', 'plugin fiscal added applied rules: SC'],
      ['hook', 'fiscal', 'afterEvaluate', 'plugin fiscal removed applied rules: r2'],
      ['hook', 'fiscal', 'afterEvaluate', 'plugin fiscal added skipped rules: r2'],
      ['hook', 'fiscal', 'afterEvaluate', 'plugin fiscal removed skipped rules: gone'],
    ]);
  });

  it('refuses a rewritten value that is not a finite number', async () => {
    const rewriting = pluginWith('fiscal', {
      afterEvaluate(_input, result): EvaluationResult {
        return { ...result, value: 'zero', appliedRules: [] };
      },
    });
    const result = await engineWith([rewriting]).evaluate(
      [makeRule({ id: 'r1', model: 'M' })],
      makeInput(),
    );
    expect(result.value).toBe(100);
    expect(result.appliedRules.map((r) => r.id)).toEqual(['r1']);
    expect(result.diagnostics).toEqual([
      {
        source: 'hook',
        plugin: 'fiscal',
        hook: 'afterEvaluate',
        message:
          'plugin fiscal rewrote output value to "zero", not a finite number: result ignored',
      },
    ]);
  });

  it('hands plugins a copy: in-place writes do not reach the engine records or the rules', async () => {
    const rule = makeRule({ id: 'r1', model: 'M', params: { rate: 1 } });
    const careless = pluginWith('careless', {
      afterEvaluate(_input, result): EvaluationResult {
        // A careless plugin writing through the readonly types.
        const writable: MutableResult = result as unknown as MutableResult;
        writable.value = 0;
        writable.outputs['value']!.contributors.push('ghost');
        writable.appliedRules.push({ id: 'SC', model: 'META_SHORT_CIRCUIT', params: {} });
        writable.appliedRules[0]!.params['rate'] = 2;
        return result;
      },
    });
    let seenByNext: unknown;
    const next = pluginWith('next', {
      afterEvaluate(_input, result): EvaluationResult {
        seenByNext = result.value;
        return result;
      },
    });
    const result = await engineWith([careless, next]).evaluate([rule], makeInput());
    expect(rule.params).toEqual({ rate: 1 });
    expect(seenByNext).toBe(0);
    expect(result.outputs['value']).toEqual({
      name: 'value',
      type: 'number',
      combine: 'sum',
      value: 0,
      contributors: ['r1'],
    });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'plugin careless rewrote output value from 100 to 0',
      'plugin careless changed engine-owned fields outputs; ignored (rewrite value instead)',
      'plugin careless added applied rules: SC',
      'plugin careless changed applied rules: r1',
    ]);
  });
});

describe('Outputs belong to the engine', () => {
  const RISK = { type: 'string', combine: 'highestPriority' } as const;

  function engineWithRisk(plugins: PPEPlugin[]): PPEEngine {
    const host: PPEPlugin = {
      name: 'model-host',
      version: '1.0.0',
      onInit(context: PluginContext): void {
        context.modelRegistry.register(new StubModel('M', 100));
        context.modelRegistry.register(new ValueModel('RISK', RISK, { k: 'low' }));
      },
    };
    return new PPEEngine({ plugins: [host, ...plugins], dsls: [], strict: false });
  }

  const rules = (): Rule[] => [
    makeRule({ id: 'r1', model: 'M' }),
    makeRule({ id: 'k', model: 'RISK', output: 'risk' }),
  ];

  it('ignores a direct change of outputs.value.value and says so', async () => {
    const sneaky = pluginWith('sneaky', {
      afterEvaluate(_input, result): EvaluationResult {
        const value = { ...result.outputs['value']!, value: 7 };
        return { ...result, outputs: { ...result.outputs, value } };
      },
    });
    const result = await engineWithRisk([sneaky]).evaluate(rules(), makeInput());
    expect(result.value).toBe(100);
    expect(result.outputs['value']!.value).toBe(100);
    expect(result.diagnostics).toEqual([
      {
        source: 'hook',
        plugin: 'sneaky',
        hook: 'afterEvaluate',
        message:
          'plugin sneaky changed engine-owned fields outputs; ignored (rewrite value instead)',
      },
    ]);
  });

  it('ignores added, removed or changed outputs of any name', async () => {
    const sneaky = pluginWith('sneaky', {
      afterEvaluate(_input, result): EvaluationResult {
        const kept = Object.fromEntries(
          Object.entries(result.outputs).filter(([name]) => name !== 'risk'),
        );
        return {
          ...result,
          outputs: { ...kept, extra: { ...result.outputs['value']!, name: 'extra' } },
        };
      },
    });
    const result = await engineWithRisk([sneaky]).evaluate(rules(), makeInput());
    expect(Object.keys(result.outputs).sort()).toEqual(['risk', 'value']);
    expect(result.outputs['risk']!.value).toBe('low');
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'plugin sneaky changed engine-owned fields outputs; ignored (rewrite value instead)',
    ]);
  });

  it('accepts a value rewrite that also syncs outputs.value itself, without a second diagnostic', async () => {
    const tidy = pluginWith('tidy', {
      afterEvaluate(_input, result): EvaluationResult {
        const value = { ...result.outputs['value']!, value: 0 };
        return { ...result, value: 0, outputs: { ...result.outputs, value } };
      },
    });
    const result = await engineWithRisk([tidy]).evaluate(rules(), makeInput());
    expect(result.outputs['value']!.value).toBe(0);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'plugin tidy rewrote output value from 100 to 0',
    ]);
  });
});

describe('Hook timeouts and onError typing', () => {
  it('reports a hook timeout as a HookTimeoutError naming the plugin and hook', async () => {
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
    const result = await engine.evaluate([makeRule({ id: 'r1', model: 'M' })], makeInput());
    expect(result.value).toBe(100);
    expect(result.diagnostics).toEqual([
      {
        source: 'hook',
        plugin: 'slow',
        hook: 'beforeEvaluate',
        message: 'plugin slow hook beforeEvaluate timed out after 20 ms',
      },
    ]);
    const error: unknown = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(HookTimeoutError);
    expect(error).toMatchObject({
      code: 'HOOK_TIMEOUT',
      pluginName: 'slow',
      hook: 'beforeEvaluate',
      timeoutMs: 20,
    });
  });

  it('wraps a non-PPEError hook error for onError, keeping the original as cause', async () => {
    const thrown = new TypeError('bad shape');
    const onError = vi.fn();
    const broken = pluginWith('broken', {
      afterEvaluate(): EvaluationResult {
        throw thrown;
      },
      onError,
    });
    const result = await engineWith([broken]).evaluate(
      [makeRule({ id: 'r1', model: 'M' })],
      makeInput(),
    );
    expect(result.diagnostics.map((d) => d.message)).toEqual(['bad shape']);
    const error: unknown = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(UnexpectedEngineError);
    expect(error).toMatchObject({ code: 'UNEXPECTED', message: 'bad shape', cause: thrown });
  });

  it('passes a PPEError to onError as is', async () => {
    const thrown = new PPEError('known', 'KNOWN');
    const onError = vi.fn();
    const broken = pluginWith('broken', {
      beforeEvaluate(): BeforeEvaluateResult {
        throw thrown;
      },
      onError,
    });
    await engineWith([broken]).evaluate([makeRule({ id: 'r1', model: 'M' })], makeInput());
    expect(onError).toHaveBeenCalledWith(thrown, expect.anything());
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
    expect(error).toMatchObject({ code: 'UNEXPECTED', message: 'model crash', cause: thrown });
  });
});
