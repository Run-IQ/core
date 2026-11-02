import { describe, it, expect, vi } from 'vitest';

// `unknown` is a result of a membership in a referential, which core cannot provide before 9Q:
// spec's matchDimension is replaced by one that answers it.
vi.mock('@run-iq/spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@run-iq/spec')>()),
  matchDimension: () => ({ result: 'unknown', why: 'code "X" not valid at "2024-06-01"' }),
}));

const { RuleFilter } = await import('../../src/engine/RuleFilter.js');
const { DSLRegistry } = await import('../../src/registry/DSLRegistry.js');
const { PluginSandbox } = await import('../../src/security/PluginSandbox.js');
const { makeRule, makeInput } = await import('../helpers.js');

describe('RuleFilter: a dimension that spec cannot decide', () => {
  it('excludes the rule, naming why spec could not decide', async () => {
    const filter = new RuleFilter(new DSLRegistry(), new PluginSandbox(500, 100));
    const rule = makeRule({ id: 'r1', model: 'M', dimensions: { country: 'TG' } });
    const input = makeInput({ meta: { tenantId: 't', dimensions: { country: 'TG' } } });
    const result = await filter.filter([rule], input, new Date('2024-06-01T00:00:00.000Z'));
    expect(result.passed).toEqual([]);
    expect(result.skipped).toEqual([
      {
        rule,
        reason: 'DIMENSION_MISMATCH',
        detail: 'country: rule TG, input TG (unknown: code "X" not valid at "2024-06-01")',
      },
    ]);
  });
});
