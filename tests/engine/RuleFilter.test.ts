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

  describe('half-open window', () => {
    it('excludes a rule whose effectiveUntil equals the evaluated date', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
        effectiveUntil: new Date('2024-06-01T00:00:00.000Z'),
      });
      const result = await createFilter().filter(
        [rule],
        makeInput(),
        new Date('2024-06-01T00:00:00.000Z'),
      );
      expect(result.passed).toEqual([]);
      expect(result.skipped).toEqual([
        {
          rule,
          reason: 'INACTIVE_DATE',
          detail:
            'window [2024-01-01T00:00:00.000Z, 2024-06-01T00:00:00.000Z), evaluated at 2024-06-01T00:00:00.000Z',
        },
      ]);
    });

    it('formats an invalid effectiveUntil defensively', async () => {
      // makeRule seals a checksum, which refuses an invalid date: corrupt the rule afterwards.
      const rule = {
        ...makeRule({
          id: 'r1',
          model: 'M',
          effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
        }),
        effectiveUntil: new Date('x'),
      };
      const result = await createFilter().filter(
        [rule],
        makeInput(),
        new Date('2024-06-01T00:00:00.000Z'),
      );
      expect(result.skipped[0]).toMatchObject({
        reason: 'INACTIVE_DATE',
        detail:
          'window [2025-01-01T00:00:00.000Z, Invalid Date), evaluated at 2024-06-01T00:00:00.000Z',
      });
    });

    it('includes a rule whose effectiveFrom equals the evaluated date', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        effectiveFrom: new Date('2024-06-01T00:00:00.000Z'),
      });
      const result = await createFilter().filter(
        [rule],
        makeInput(),
        new Date('2024-06-01T00:00:00.000Z'),
      );
      expect(result.passed).toEqual([rule]);
    });

    it('states an open-ended window in the detail', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      });
      const result = await createFilter().filter(
        [rule],
        makeInput(),
        new Date('2024-06-01T00:00:00.000Z'),
      );
      expect(result.skipped[0]!.detail).toBe(
        'window [2025-01-01T00:00:00.000Z, infinity), evaluated at 2024-06-01T00:00:00.000Z',
      );
    });
  });

  describe('dimensions', () => {
    const at = new Date('2024-06-01');

    it('does not filter by dimensions when meta.dimensions is undefined', async () => {
      const rule = makeRule({ id: 'r1', model: 'M', dimensions: { country: 'TG' } });
      const result = await createFilter().filter([rule], makeInput(), at);
      expect(result.passed).toEqual([rule]);
      expect(result.skipped).toEqual([]);
    });

    it('excludes a rule whose dimension value differs', async () => {
      const rule = makeRule({ id: 'r1', model: 'M', dimensions: { country: 'BJ' } });
      const input = makeInput({ meta: { tenantId: 't', dimensions: { country: 'TG' } } });
      const result = await createFilter().filter([rule], input, at);
      expect(result.passed).toEqual([]);
      expect(result.skipped).toEqual([
        { rule, reason: 'DIMENSION_MISMATCH', detail: 'country: rule BJ, input TG' },
      ]);
    });

    it('excludes a rule whose dimension key is absent from the input', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        dimensions: { country: 'TG', region: 'X' },
      });
      const input = makeInput({ meta: { tenantId: 't', dimensions: { country: 'TG' } } });
      const result = await createFilter().filter([rule], input, at);
      expect(result.skipped).toEqual([
        { rule, reason: 'DIMENSION_MISMATCH', detail: 'region: rule X, input has no region' },
      ]);
    });

    it('passes matching and dimensionless rules', async () => {
      const matching = makeRule({ id: 'r1', model: 'M', dimensions: { country: 'TG' } });
      const free = makeRule({ id: 'r2', model: 'M' });
      const input = makeInput({ meta: { tenantId: 't', dimensions: { country: 'TG' } } });
      const result = await createFilter().filter([matching, free], input, at);
      expect(result.passed).toEqual([matching, free]);
    });

    it('checks tags before dimensions', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        tags: ['tax'],
        dimensions: { country: 'BJ' },
      });
      const input = makeInput({
        meta: { tenantId: 't', tags: ['payroll'], dimensions: { country: 'TG' } },
      });
      const result = await createFilter().filter([rule], input, at);
      expect(result.skipped.map((s) => s.reason)).toEqual(['TAG_MISMATCH']);
    });
  });

  describe('missing facts', () => {
    const at = new Date('2024-06-01');

    class ListingDSL implements DSLEvaluator {
      readonly dsl = 'listing';
      readonly version = '1.0.0';
      evaluate(): boolean {
        return true;
      }
      listVariables(expression: unknown): string[] {
        return Array.isArray(expression) ? expression.map(String) : [];
      }
    }

    function listingFilter(): RuleFilter {
      const registry = new DSLRegistry();
      registry.register(new ListingDSL());
      return new RuleFilter(registry, new PluginSandbox(500, 100));
    }

    it('reports dotted paths absent from data, sorted and unique', async () => {
      const rules = [
        makeRule({
          id: 'r1',
          model: 'M',
          condition: { dsl: 'listing', value: ['revenue.total', 'amount', 'zone'] },
        }),
        makeRule({
          id: 'r2',
          model: 'M',
          condition: { dsl: 'listing', value: ['revenue.total', 'a.b.c'] },
        }),
      ];
      const input = makeInput({ data: { amount: 5, zone: undefined, a: { b: {} } } });
      const result = await listingFilter().filter(rules, input, at);
      expect(result.missingFacts).toEqual(['a.b.c', 'revenue.total', 'zone']);
    });

    it('resolves a present dotted path object by object', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        condition: { dsl: 'listing', value: ['revenue.total'] },
      });
      const input = makeInput({ data: { revenue: { total: 0 } } });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual([]);
    });

    it('ignores conditions of rules excluded before evaluation', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        dimensions: { country: 'BJ' },
        condition: { dsl: 'listing', value: ['revenue.total'] },
      });
      const input = makeInput({ meta: { tenantId: 't', dimensions: { country: 'TG' } } });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual([]);
    });

    it('does not resolve inherited properties', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        condition: {
          dsl: 'listing',
          value: ['constructor', 'toString', '__proto__', 'a.constructor', 'items.length'],
        },
      });
      const input = makeInput({ data: { a: {}, items: [1, 2] } });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual([
        '__proto__',
        'a.constructor',
        'constructor',
        'items.length',
        'toString',
      ]);
    });

    it('resolves an own __proto__ key and own array indices', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        condition: { dsl: 'listing', value: ['__proto__.x', 'items.0', 'items.5'] },
      });
      const data: Record<string, unknown> = JSON.parse('{"__proto__":{"x":1},"items":[7]}');
      const result = await listingFilter().filter([rule], makeInput({ data }), at);
      expect(result.missingFacts).toEqual(['items.5']);
    });

    it('treats a path through a non-object as missing', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        condition: { dsl: 'listing', value: ['s.b', 'n.b', 'z.b', 'z'] },
      });
      const input = makeInput({ data: { s: 'text', n: 3, z: null } });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual(['n.b', 's.b', 'z.b']);
    });

    it('ignores an empty path', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        condition: { dsl: 'listing', value: ['', 'x'] },
      });
      const result = await listingFilter().filter([rule], makeInput(), at);
      expect(result.missingFacts).toEqual(['x']);
    });

    it.each([
      ['an Error', new Error('boom'), 'boom'],
      ['a string', 'plain', 'plain'],
      ['an object', { code: 1 }, '[object Object]'],
    ])(
      'keeps the outcome and reports a diagnostic when listVariables throws %s',
      async (_n, thrown, text) => {
        const registry = new DSLRegistry();
        registry.register({
          dsl: 'flaky',
          version: '1.0.0',
          evaluate: () => true,
          listVariables: () => {
            throw thrown;
          },
        });
        const filter = new RuleFilter(registry, new PluginSandbox(500, 100));
        const rule = makeRule({ id: 'r1', model: 'M', condition: { dsl: 'flaky', value: {} } });
        const result = await filter.filter([rule], makeInput(), at);
        expect(result.passed).toEqual([rule]);
        expect(result.skipped).toEqual([]);
        expect(result.missingFacts).toEqual([]);
        expect(result.diagnostics).toEqual([
          { source: 'engine', message: `listVariables failed for r1@1 (flaky): ${text}` },
        ]);
      },
    );

    it('adds nothing when listVariables throws midway through a lazy iterable', async () => {
      const registry = new DSLRegistry();
      registry.register({
        dsl: 'lazy',
        version: '1.0.0',
        evaluate: () => true,
        listVariables: function* () {
          yield 'first.missing';
          throw new Error('midway');
        },
      });
      const filter = new RuleFilter(registry, new PluginSandbox(500, 100));
      const rule = makeRule({ id: 'r1', model: 'M', condition: { dsl: 'lazy', value: {} } });
      const result = await filter.filter([rule], makeInput(), at);
      expect(result.missingFacts).toEqual([]);
      expect(result.passed).toEqual([rule]);
      expect(result.diagnostics).toEqual([
        { source: 'engine', message: 'listVariables failed for r1@1 (lazy): midway' },
      ]);
    });

    it('stays empty when the DSL has no listVariables', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        condition: { dsl: 'jsonlogic', value: { var: 'revenue.total' } },
      });
      const result = await createFilter([{ name: 'jsonlogic', result: true }]).filter(
        [rule],
        makeInput(),
        at,
      );
      expect(result.missingFacts).toEqual([]);
      expect(result.passed).toEqual([rule]);
    });
  });

  describe('exclusion detail', () => {
    const at = new Date('2024-06-01');

    it('names the tags on TAG_MISMATCH', async () => {
      const rule = makeRule({ id: 'r1', model: 'M', tags: ['tax', 'vat'] });
      const input = makeInput({ meta: { tenantId: 't', tags: ['payroll'] } });
      const result = await createFilter().filter([rule], input, at);
      expect(result.skipped[0]!.detail).toBe('rule tags [tax, vat], input tags [payroll]');
    });

    it('sets a detail on CONDITION_FALSE', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        condition: { dsl: 'jsonlogic', value: {} },
      });
      const result = await createFilter([{ name: 'jsonlogic', result: false }]).filter(
        [rule],
        makeInput(),
        at,
      );
      expect(result.skipped[0]!.detail).toBe('condition evaluated to false');
    });

    it('carries the DSL error message on DSL_ERROR', async () => {
      const registry = new DSLRegistry();
      registry.register({
        dsl: 'broken',
        version: '1.0.0',
        evaluate: () => {
          throw new Error('invalid expression');
        },
      });
      const filter = new RuleFilter(registry, new PluginSandbox(500, 100));
      const rule = makeRule({ id: 'r1', model: 'M', condition: { dsl: 'broken', value: 'x' } });
      const result = await filter.filter([rule], makeInput(), at);
      expect(result.skipped[0]).toMatchObject({
        reason: 'DSL_ERROR',
        detail: 'invalid expression',
      });
    });

    it('names the DSL on DSL_NOT_FOUND', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        condition: { dsl: 'unknown_dsl', value: {} },
      });
      const result = await createFilter().filter([rule], makeInput(), at);
      expect(result.skipped[0]).toMatchObject({
        reason: 'DSL_NOT_FOUND',
        detail: 'DSL not found: unknown_dsl',
      });
    });

    it('describes the timeout on CONDITION_TIMEOUT', async () => {
      const registry = new DSLRegistry();
      registry.register({
        dsl: 'slow',
        version: '1.0.0',
        evaluate: () =>
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(true), 200);
          }),
      });
      const filter = new RuleFilter(registry, new PluginSandbox(500, 20));
      const rule = makeRule({ id: 'r1', model: 'M', condition: { dsl: 'slow', value: {} } });
      const result = await filter.filter([rule], makeInput(), at);
      expect(result.skipped[0]).toMatchObject({
        reason: 'CONDITION_TIMEOUT',
        detail: 'DSL "slow" evaluation timed out after 20ms',
      });
    });
  });
});
