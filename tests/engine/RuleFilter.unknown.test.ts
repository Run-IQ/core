import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// `unknown` is a result of a membership in a referential, which core cannot provide before 9Q:
// spec's matchDimension is replaced by one that answers it.
const matchDimension = vi.hoisted(() => vi.fn());
vi.mock('@run-iq/spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@run-iq/spec')>()),
  matchDimension,
}));

const { RuleFilter } = await import('../../src/engine/RuleFilter.js');
const { DSLRegistry } = await import('../../src/registry/DSLRegistry.js');
const { PluginSandbox } = await import('../../src/security/PluginSandbox.js');
const { makeRule, makeInput } = await import('../helpers.js');

describe('RuleFilter: a dimension that spec cannot decide', () => {
  // The test pins its own zone: in Tokyo the evaluation instant below is already 2024-06-16, so
  // a date taken from local time fails on every machine, CI (UTC) included.
  const zone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'Asia/Tokyo';
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('excludes the rule, naming why spec could not decide', async () => {
    matchDimension.mockReturnValue({
      result: 'unknown',
      why: 'code "X" not valid at "2024-06-01"',
    });
    const filter = new RuleFilter(new DSLRegistry(), new PluginSandbox(500, 100));
    const rule = makeRule({ id: 'r1', model: 'M', dimensions: { country: 'TG' } });
    const input = makeInput({ meta: { tenantId: 't', dimensions: { country: 'TG' } } });
    const result = await filter.filter([rule], input, new Date('2024-06-15T23:30:00.000Z'));
    // Called with the rule's spec, the input value, the UTC civil date of the evaluation and no
    // referential.
    expect(matchDimension.mock.calls).toEqual([['TG', 'TG', '2024-06-15', new Map()]]);
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
