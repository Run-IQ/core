import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { makeRule, makeInput, StubModel, StubPlugin } from '../helpers.js';

describe('Multi-plugin', () => {
  it('supports multiple plugins with different models', async () => {
    const model1 = new StubModel('M1', 100);
    const model2 = new StubModel('M2', 200);

    const plugin1 = new StubPlugin('plugin-a', [model1]);
    const plugin2 = new StubPlugin('plugin-b', [model2]);

    const engine = new PPEEngine({
      plugins: [plugin1, plugin2],
      dsls: [],
      strict: false,
    });

    const rules = [
      makeRule({ id: 'r1', model: 'M1', priority: 200, params: {} }),
      makeRule({ id: 'r2', model: 'M2', priority: 100, params: {} }),
    ];

    const result = await engine.evaluate(rules, makeInput());
    expect(result.value).toBe(300);
    expect(result.breakdown).toHaveLength(2);
    expect(result.pluginVersions['plugin-a']).toBe('1.0.0');
    expect(result.pluginVersions['plugin-b']).toBe('1.0.0');
  });
});
