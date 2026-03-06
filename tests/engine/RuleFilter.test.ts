import { describe, it, expect } from 'vitest';
import { RuleFilter } from '../../src/engine/RuleFilter.js';
import { DSLRegistry } from '../../src/registry/DSLRegistry.js';
import { PluginSandbox } from '../../src/security/PluginSandbox.js';
import { makeRule, makeInput, StubDSL } from '../helpers.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';

function createFilter(dsls: { name: string; result: boolean }[] = []) {
  const registry = new DSLRegistry();
  for (const d of dsls) {
    registry.register(new StubDSL(d.name, d.result));
  }
  const sandbox = new PluginSandbox(500, 100);
  return new RuleFilter(registry, sandbox);
}

describe('RuleFilter', () => {
  it('passes rules within effective dates', async () => {
    const filter = createFilter();
    const rule = makeRule({
      id: 'r1',
      model: 'M',
      effectiveFrom: new Date('2024-01-01'),
      effectiveUntil: new Date('2025-12-31'),
    });
    const result = await filter.filter([rule], makeInput(), new Date('2024-06-01'));
    expect(result.passed).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips rules before effectiveFrom', async () => {
    const filter = createFilter();
    const rule = makeRule({
      id: 'r1',
      model: 'M',
      effectiveFrom: new Date('2025-01-01'),
    });
    const result = await filter.filter([rule], makeInput(), new Date('2024-06-01'));
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('INACTIVE_DATE');
  });

  it('skips rules after effectiveUntil', async () => {
    const filter = createFilter();
    const rule = makeRule({
      id: 'r1',
      model: 'M',
      effectiveFrom: new Date('2024-01-01'),
      effectiveUntil: new Date('2024-06-01'),
    });
    const result = await filter.filter([rule], makeInput(), new Date('2024-12-01'));
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('INACTIVE_DATE');
  });

  it('skips rules with non-matching tags', async () => {
    const filter = createFilter();
    const rule = makeRule({ id: 'r1', model: 'M', tags: ['tax'] });
    const input = makeInput({ meta: { tenantId: 't', tags: ['payroll'] } });
    const result = await filter.filter([rule], input, new Date('2024-06-01'));
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('TAG_MISMATCH');
  });

  it('passes rules with matching tags', async () => {
    const filter = createFilter();
    const rule = makeRule({ id: 'r1', model: 'M', tags: ['tax', 'vat'] });
    const input = makeInput({ meta: { tenantId: 't', tags: ['tax'] } });
    const result = await filter.filter([rule], input, new Date('2024-06-01'));
    expect(result.passed).toHaveLength(1);
  });

  it('skips rules with unregistered DSL', async () => {
    const filter = createFilter();
    const rule = makeRule({
      id: 'r1',
      model: 'M',
      condition: { dsl: 'unknown_dsl', value: {} },
    });
    const result = await filter.filter([rule], makeInput(), new Date('2024-06-01'));
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('DSL_NOT_FOUND');
  });

  it('skips rules when DSL condition evaluates to false', async () => {
    const filter = createFilter([{ name: 'jsonlogic', result: false }]);
    const rule = makeRule({
      id: 'r1',
      model: 'M',
      condition: { dsl: 'jsonlogic', value: { '==': [1, 2] } },
    });
    const result = await filter.filter([rule], makeInput(), new Date('2024-06-01'));
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('CONDITION_FALSE');
  });

  it('passes rules when DSL condition evaluates to true', async () => {
    const filter = createFilter([{ name: 'jsonlogic', result: true }]);
    const rule = makeRule({
      id: 'r1',
      model: 'M',
      condition: { dsl: 'jsonlogic', value: { '==': [1, 1] } },
    });
    const result = await filter.filter([rule], makeInput(), new Date('2024-06-01'));
    expect(result.passed).toHaveLength(1);
  });

  it('supports retroactive effectiveDate for date filtering', async () => {
    const filter = createFilter();
    const rule = makeRule({
      id: 'r1',
      model: 'M',
      effectiveFrom: new Date('2023-01-01'),
      effectiveUntil: new Date('2023-12-31'),
    });
    // Using a past date as "now" — simulates retroactive calculation
    const result = await filter.filter([rule], makeInput(), new Date('2023-06-15'));
    expect(result.passed).toHaveLength(1);

    // Using current date — rule would be expired
    const result2 = await filter.filter([rule], makeInput(), new Date('2026-03-06'));
    expect(result2.skipped).toHaveLength(1);
    expect(result2.skipped[0]!.reason).toBe('INACTIVE_DATE');
  });

  it('returns DSL_ERROR when DSL throws a non-timeout error', async () => {
    const throwingDSL: DSLEvaluator = {
      dsl: 'broken',
      version: '1.0.0',
      evaluate: () => {
        throw new Error('invalid expression');
      },
    };
    const registry = new DSLRegistry();
    registry.register(throwingDSL);
    const sandbox = new PluginSandbox(500, 100);
    const filter = new RuleFilter(registry, sandbox);

    const rule = makeRule({
      id: 'r1',
      model: 'M',
      condition: { dsl: 'broken', value: 'bad syntax' },
    });
    const result = await filter.filter([rule], makeInput(), new Date('2024-06-01'));
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('DSL_ERROR');
  });
});
