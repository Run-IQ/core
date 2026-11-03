import { describe, it, expect } from 'vitest';
import { SpecError } from '@run-iq/spec';
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

    it('rejects an invalid evaluation date with spec INVALID_DATE, before any rule', async () => {
      const rule = makeRule({ id: 'r1', model: 'M' });
      const error = await createFilter()
        .filter([rule], makeInput(), new Date('x'))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(SpecError);
      expect(error).toMatchObject({ code: 'INVALID_DATE', message: 'at must be a valid Date' });
    });

    it('skips a rule whose bound is invalid, naming the code and message of spec', async () => {
      // makeRule seals a checksum, which refuses an invalid date: corrupt the rule afterwards
      // (a rule that a beforeEvaluate hook changed is not checked again).
      const bad = {
        ...makeRule({
          id: 'bad',
          model: 'M',
          effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
        }),
        effectiveUntil: new Date('x'),
      };
      const good = makeRule({ id: 'good', model: 'M' });
      const result = await createFilter().filter(
        [bad, good],
        makeInput(),
        new Date('2024-06-01T00:00:00.000Z'),
      );
      expect(result.passed).toEqual([good]);
      expect(result.skipped).toEqual([
        {
          rule: bad,
          reason: 'INVALID_RULE',
          detail:
            'Invalid rule bad@1: INVALID_DATE: effectiveUntil must be a Date, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS[.sss] with Z or ±HH:MM, in the years 0000 to 9999; got an invalid Date',
        },
      ]);
    });

    it('skips a rule with a civil bound and an IANA time zone, the others still pass', async () => {
      // isEffectiveAt has no time zone database: only UTC and ±HH:MM.
      const paris = makeRule({
        id: 'paris',
        model: 'M',
        effectiveFrom: '2025-01-01',
        timeZone: 'Europe/Paris',
      });
      const utc = makeRule({ id: 'utc', model: 'M', effectiveFrom: '2025-01-01' });
      const result = await createFilter().filter(
        [paris, utc],
        makeInput(),
        new Date('2025-06-01T00:00:00.000Z'),
      );
      expect(result.passed).toEqual([utc]);
      expect(result.skipped).toEqual([
        {
          rule: paris,
          reason: 'INVALID_RULE',
          detail:
            'Invalid rule paris@1: INVALID_DATE: isEffectiveAt knows UTC and ±HH:MM offsets only: use windowContains with a calendar for "Europe/Paris"',
        },
      ]);
    });

    it('compares a civil date bound as a civil date, and names it as written', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        effectiveFrom: '2025-01-01',
        effectiveUntil: '2025-06-01',
      });
      const last = await createFilter().filter(
        [rule],
        makeInput(),
        new Date('2025-05-31T23:59:59.999Z'),
      );
      expect(last.passed).toEqual([rule]);
      const until = await createFilter().filter(
        [rule],
        makeInput(),
        new Date('2025-06-01T00:00:00.000Z'),
      );
      expect(until.passed).toEqual([]);
      expect(until.skipped).toEqual([
        {
          rule,
          reason: 'INACTIVE_DATE',
          detail: 'window [2025-01-01, 2025-06-01), evaluated at 2025-06-01T00:00:00.000Z',
        },
      ]);
      const before = await createFilter().filter(
        [rule],
        makeInput(),
        new Date('2024-12-31T23:59:59.999Z'),
      );
      expect(before.skipped[0]).toMatchObject({
        reason: 'INACTIVE_DATE',
        detail: 'window [2025-01-01, 2025-06-01), evaluated at 2024-12-31T23:59:59.999Z',
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

    describe('structured dimensions (spec matchDimension)', () => {
      const inCountry = (country: string) =>
        makeInput({ meta: { tenantId: 't', dimensions: { country } } });

      it('anyOf: passes a value of the list, names the spec and the value otherwise', async () => {
        const rule = makeRule({
          id: 'r1',
          model: 'M',
          dimensions: { country: { anyOf: ['TG', 'BJ'] } },
        });
        const passes = await createFilter().filter([rule], inCountry('BJ'), at);
        expect(passes.passed).toEqual([rule]);
        const refused = await createFilter().filter([rule], inCountry('CI'), at);
        expect(refused.skipped).toEqual([
          {
            rule,
            reason: 'DIMENSION_MISMATCH',
            detail: 'country: rule {"anyOf":["TG","BJ"]}, input CI',
          },
        ]);
      });

      it('match all asks every input value to match, match any (the default) one of them', async () => {
        const inZones = (zone: string[]) =>
          makeInput({ meta: { tenantId: 't', dimensions: { zone } } });
        const all = makeRule({
          id: 'all',
          model: 'M',
          dimensions: { zone: { anyOf: ['FR', 'US'], match: 'all' } },
        });
        const any = makeRule({
          id: 'any',
          model: 'M',
          dimensions: { zone: { anyOf: ['FR', 'US'] } },
        });
        const both = await createFilter().filter([all, any], inZones(['US', 'FR']), at);
        expect(both.passed).toEqual([all, any]);
        // `FR` matches, `DE` does not: any passes, all does not.
        const mixed = await createFilter().filter([all, any], inZones(['FR', 'DE']), at);
        expect(mixed.passed).toEqual([any]);
        expect(mixed.skipped).toEqual([
          {
            rule: all,
            reason: 'DIMENSION_MISMATCH',
            detail: 'zone: rule {"anyOf":["FR","US"],"match":"all"}, input [DE, FR]',
          },
        ]);
        const none = await createFilter().filter([all, any], inZones(['DE', 'IT']), at);
        expect(none.passed).toEqual([]);
        // One value: all and any agree.
        expect((await createFilter().filter([all, any], inZones(['FR', 'FR']), at)).passed).toEqual(
          [all, any],
        );
      });

      it('a qualified value matches as written', async () => {
        const rule = makeRule({
          id: 'r1',
          model: 'M',
          dimensions: { activity: 'nace-2.1:62.10' },
        });
        const input = makeInput({
          meta: { tenantId: 't', dimensions: { activity: 'nace-2.1:62.10' } },
        });
        expect((await createFilter().filter([rule], input, at)).passed).toEqual([rule]);
      });

      it('an input value spec cannot read rejects the evaluation, unchanged', async () => {
        const rule = makeRule({ id: 'r1', model: 'M', dimensions: { country: 'TG' } });
        const refused = async (country: string): Promise<unknown> =>
          createFilter()
            .filter([rule], inCountry(country), at)
            .then(
              () => undefined,
              (error: unknown) => error,
            );
        for (const [value, message] of [
          ['', 'input must not be empty'],
          [':x', 'input has an empty code system before ":"'],
        ] as const) {
          const error = await refused(value);
          expect(error).toBeInstanceOf(SpecError);
          expect(error).toMatchObject({ code: 'INVALID_INPUT', message });
        }
      });

      it('a ref names the spec error: no referential is provided yet, never a silent mismatch', async () => {
        const rule = makeRule({
          id: 'r1',
          model: 'M',
          dimensions: { country: { ref: 'ue', anyOf: ['EU'], except: ['FR'] } },
        });
        const result = await createFilter().filter([rule], inCountry('TG'), at);
        expect(result.passed).toEqual([]);
        expect(result.skipped).toEqual([
          {
            rule,
            reason: 'INVALID_RULE',
            detail:
              'Invalid rule r1@1: dimension country: INVALID_REFERENTIAL: unknown referential ue',
          },
        ]);
      });
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

  describe('missing facts (JSON pointers of the evaluation context)', () => {
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

    const reading = (id: string, ...pointers: string[]) =>
      makeRule({ id, model: 'M', condition: { dsl: 'listing', value: pointers } });

    it('reports pointers absent from data, sorted and unique', async () => {
      const rules = [
        reading('r1', '/revenue/total', '/amount', '/zone'),
        reading('r2', '/revenue/total', '/a/b/c'),
      ];
      const input = makeInput({ data: { amount: 5, zone: undefined, a: { b: {} } } });
      const result = await listingFilter().filter(rules, input, at);
      expect(result.missingFacts).toEqual(['/a/b/c', '/revenue/total', '/zone']);
    });

    it('sorts by the decoded segments, not by the escaped text', async () => {
      // `~1` is "/" and `~0` is "~": decoded, "/" (0x2F) comes before "~" (0x7E).
      const rule = reading('r1', '/~0a', '/~1a');
      const result = await listingFilter().filter([rule], makeInput(), at);
      expect(result.missingFacts).toEqual(['/~1a', '/~0a']);
    });

    it('resolves a present pointer object by object', async () => {
      const rule = reading('r1', '/revenue/total');
      const input = makeInput({ data: { revenue: { total: 0 } } });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual([]);
    });

    it('ignores conditions of rules excluded before evaluation', async () => {
      const rule = makeRule({
        id: 'r1',
        model: 'M',
        dimensions: { country: 'BJ' },
        condition: { dsl: 'listing', value: ['/revenue/total'] },
      });
      const input = makeInput({ meta: { tenantId: 't', dimensions: { country: 'TG' } } });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual([]);
    });

    it('does not resolve inherited properties', async () => {
      const rule = reading(
        'r1',
        '/constructor',
        '/toString',
        '/__proto__',
        '/a/constructor',
        '/items/length',
      );
      const input = makeInput({ data: { a: {}, items: [1, 2] } });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual([
        '/__proto__',
        '/a/constructor',
        '/constructor',
        '/items/length',
        '/toString',
      ]);
    });

    it('resolves an own __proto__ key and own array indices', async () => {
      const rule = reading('r1', '/__proto__/x', '/items/0', '/items/5');
      const data: Record<string, unknown> = JSON.parse('{"__proto__":{"x":1},"items":[7]}');
      const result = await listingFilter().filter([rule], makeInput({ data }), at);
      expect(result.missingFacts).toEqual(['/items/5']);
    });

    it('names a list element by its index written without a leading zero', async () => {
      // `enfants[1]` exists, but `/enfants/01/age` does not name it: that fact is absent.
      const rule = reading('r1', '/enfants/01/age', '/enfants/1/age', '/enfants/2/age');
      const data = { enfants: [{ age: 4 }, { age: 6 }] };
      const result = await listingFilter().filter([rule], makeInput({ data }), at);
      expect(result.missingFacts).toEqual(['/enfants/01/age', '/enfants/2/age']);
    });

    it('does not read an index past the end, or a hole', async () => {
      const rule = reading('r1', '/items/1', '/items/2');
      // eslint-disable-next-line no-sparse-arrays
      const data = { items: [1, , 3] };
      const result = await listingFilter().filter([rule], makeInput({ data }), at);
      expect(result.missingFacts).toEqual(['/items/1']);
    });

    it('does not read a list element inherited from Array.prototype', async () => {
      const rule = reading('r1', '/items/0', '/items/1');
      const polluted = Array.prototype as unknown as Record<string, unknown>;
      polluted['1'] = 'inherited';
      try {
        const result = await listingFilter().filter(
          [rule],
          makeInput({ data: { items: [7] } }),
          at,
        );
        expect(result.missingFacts).toEqual(['/items/1']);
      } finally {
        delete polluted['1'];
      }
    });

    it('compares keys as they are: two spellings of é are two facts', async () => {
      const precomposed = 'é';
      const combining = 'é';
      const rule = reading('r1', `/${precomposed}`, `/${combining}`);
      const result = await listingFilter().filter(
        [rule],
        makeInput({ data: { [precomposed]: 1 } }),
        at,
      );
      expect(result.missingFacts).toEqual([`/${combining}`]);
    });

    it('treats a pointer through a non-object as missing', async () => {
      const rule = reading('r1', '/s/b', '/n/b', '/z/b', '/z');
      const input = makeInput({ data: { s: 'text', n: 3, z: null } });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual(['/n/b', '/s/b', '/z/b']);
    });

    it('never calls the root a missing fact', async () => {
      const result = await listingFilter().filter([reading('r1', '', '/x')], makeInput(), at);
      expect(result.missingFacts).toEqual(['/x']);
    });

    it('reads $dates and $dimensions from the normalized meta', async () => {
      const rule = reading(
        'r1',
        '/$dates/effective',
        '/$dates/facture',
        '/$dimensions/country',
        '/$dimensions/zone',
      );
      const input = makeInput({
        meta: {
          tenantId: 't',
          dates: { effective: '2026-01-01T01:00:00+01:00' },
          dimensions: { country: ['TG'] },
        },
      });
      const result = await listingFilter().filter([rule], input, at);
      expect(result.missingFacts).toEqual(['/$dates/facture', '/$dimensions/zone']);
    });

    it('does not take the other engine variables for facts: they are not read here', async () => {
      const rule = reading('r1', '/$outputs/risk/level', '/$item/age', '/$params/rate', '/$foo');
      const result = await listingFilter().filter([rule], makeInput(), at);
      expect(result.missingFacts).toEqual([]);
      expect(result.passed).toEqual([rule]);
    });

    it('hands the DSL the context: data at the root, $dates, $dimensions and an empty $outputs', async () => {
      const seen: unknown[] = [];
      const registry = new DSLRegistry();
      registry.register({
        dsl: 'spy',
        version: '1.0.0',
        evaluate: (_expression, context) => {
          seen.push(context);
          return true;
        },
      });
      const filter = new RuleFilter(registry, new PluginSandbox(500, 100));
      const rule = makeRule({ id: 'r1', model: 'M', condition: { dsl: 'spy', value: {} } });
      const input = makeInput({
        data: { amount: 5 },
        meta: { tenantId: 't', dates: { effective: '2026-01-01' }, dimensions: { country: 'TG' } },
      });
      await filter.filter([rule], input, at);
      expect(seen).toEqual([
        {
          amount: 5,
          $dates: { effective: '2026-01-01' },
          $dimensions: { country: 'TG' },
          $outputs: {},
        },
      ]);
      // The DSL gets a view that refuses writes with a dedicated error (a view is not `isFrozen`).
      expect(() => {
        (seen[0] as Record<string, unknown>)['amount'] = 1;
      }).toThrow('wrote to its input: amount');
    });

    describe('a listVariables that does not conform (D-39)', () => {
      it('names a dotted path, keeps the pointers it gave, and keeps the outcome', async () => {
        const rule = reading('r1', 'revenue.total', '/x');
        const result = await listingFilter().filter([rule], makeInput(), at);
        expect(result.passed).toEqual([rule]);
        expect(result.missingFacts).toEqual(['/x']);
        expect(result.diagnostics).toEqual([
          {
            source: 'engine',
            message: 'listVariables of listing for r1@1 returned a non-pointer: revenue.total',
          },
        ]);
      });

      it("names a '-' index as an invalid path", async () => {
        const rule = reading('r1', '/enfants/-');
        const result = await listingFilter().filter([rule], makeInput(), at);
        expect(result.missingFacts).toEqual([]);
        expect(result.diagnostics).toEqual([
          {
            source: 'engine',
            message:
              "listVariables of listing for r1@1 returned an invalid path: /enfants/- ('-' is not an index)",
          },
        ]);
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
            { source: 'engine', message: `listVariables of flaky for r1@1 failed: ${text}` },
          ]);
        },
      );

      it('adds nothing when listVariables returns a lazy iterable, which is not a list', async () => {
        const registry = new DSLRegistry();
        registry.register({
          dsl: 'lazy',
          version: '1.0.0',
          evaluate: () => true,
          // A hostile plugin returns a lazy iterable, not the array the contract asks for.
          listVariables: function* () {
            yield '/first/missing';
          } as unknown as NonNullable<DSLEvaluator['listVariables']>,
        });
        const filter = new RuleFilter(registry, new PluginSandbox(500, 100));
        const rule = makeRule({ id: 'r1', model: 'M', condition: { dsl: 'lazy', value: {} } });
        const result = await filter.filter([rule], makeInput(), at);
        expect(result.missingFacts).toEqual([]);
        expect(result.passed).toEqual([rule]);
        expect(result.diagnostics).toEqual([
          {
            source: 'engine',
            message: 'listVariables of lazy for r1@1 failed: [object Generator] is not a list',
          },
        ]);
      });
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
      expect(result.diagnostics).toEqual([]);
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
  });
});
