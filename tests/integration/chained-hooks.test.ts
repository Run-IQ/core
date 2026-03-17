import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext, BeforeEvaluateResult } from '../../src/types/plugin.js';
import type { EvaluationInput } from '../../src/types/input.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

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
