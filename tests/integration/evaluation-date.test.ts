import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

const host: PPEPlugin = {
  name: 'model-host',
  version: '1.0.0',
  onInit(context: PluginContext): void {
    context.modelRegistry.register(new StubModel('m', 100));
  },
};

const engine = (plugins: PPEPlugin[] = []): PPEEngine =>
  new PPEEngine({ plugins: [host, ...plugins], dsls: [], strict: false });

describe('the evaluation date is an input, a rule bound is a rule', () => {
  it('an invalid meta.effectiveDate rejects the evaluation, naming meta.effectiveDate', async () => {
    // The input is checked first (9L): the reason cites spec's words for an invalid Date. A caller
    // of RuleFilter itself still gets spec's INVALID_DATE (tests/engine/RuleFilter.test.ts).
    const input = makeInput({ meta: { tenantId: 't', effectiveDate: new Date('x') } });
    const error = await engine()
      .evaluate([makeRule({ id: 'r1', model: 'm' })], input)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      message: 'Invalid evaluation input',
      reasons: [
        'meta.effectiveDate: a reference date must be a Date, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS[.sss] with Z or ±HH:MM, in the years 0000 to 9999; got an invalid Date',
      ],
    });
  });

  it('a bound a hook corrupts is a rule rewritten under its name: the evaluation fails', async () => {
    const corrupt: PPEPlugin = {
      name: 'corrupt',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: (input, rules) => ({
        input,
        rules: rules.map((r) => (r.id === 'bad' ? { ...r, effectiveUntil: new Date('x') } : r)),
      }),
    };
    const error = await engine([corrupt])
      .evaluate(
        [makeRule({ id: 'bad', model: 'm' }), makeRule({ id: 'good', model: 'm' })],
        makeInput({ meta: { tenantId: 't', effectiveDate: new Date('2025-06-01T00:00:00.000Z') } }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(PluginHookError);
    expect((error as PluginHookError).cause).toMatchObject({
      message: expect.stringMatching(/^plugin corrupt rewrote rule bad@1: /),
    });
  });

  describe('the evaluation date: meta.effectiveDate, or meta.dates.effective', () => {
    const inJune = makeRule({
      id: 'june',
      model: 'm',
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveUntil: new Date('2025-06-01T00:00:00.000Z'),
    });
    const evaluateAt = (meta: Record<string, unknown>, strict = false) =>
      new PPEEngine({ plugins: [host], dsls: [], strict }).evaluate(
        [inJune],
        makeInput({ meta: { tenantId: 't', ...meta } }),
      );

    it('takes meta.dates.effective when there is no effectiveDate', async () => {
      const before = await evaluateAt({ dates: { effective: '2025-05-31T23:59:59.999Z' } });
      expect(before.appliedRules.map((r) => r.id)).toEqual(['june']);
      const until = await evaluateAt({ dates: { effective: '2025-06-01T00:00:00.000Z' } });
      expect(until.skippedRules.map((s) => [s.rule.id, s.reason])).toEqual([
        ['june', 'INACTIVE_DATE'],
      ]);
    });

    it('reads an offset date as the instant it names', async () => {
      // 2025-06-01T01:00:00+01:00 is 2025-06-01T00:00:00Z: the window is closed.
      const result = await evaluateAt({ dates: { effective: '2025-06-01T01:00:00+01:00' } });
      expect(result.appliedRules).toEqual([]);
    });

    it('reads a civil date as the start of that day in UTC (9P refines it)', async () => {
      expect((await evaluateAt({ dates: { effective: '2025-05-31' } })).appliedRules).toHaveLength(
        1,
      );
      expect((await evaluateAt({ dates: { effective: '2025-06-01' } })).appliedRules).toEqual([]);
    });

    it('takes meta.effectiveDate, alone or equal to dates.effective', async () => {
      const date = new Date('2025-05-31T12:00:00.000Z');
      expect((await evaluateAt({ effectiveDate: date })).appliedRules).toHaveLength(1);
      const both = await evaluateAt({
        effectiveDate: date,
        dates: { effective: '2025-05-31T14:00:00+02:00' },
      });
      expect(both.appliedRules).toHaveLength(1);
    });

    it('refuses an effectiveDate that differs from dates.effective', async () => {
      const error = await evaluateAt({
        effectiveDate: new Date('2025-05-31T12:00:00.000Z'),
        dates: { effective: '2025-05-30' },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).reasons).toEqual([
        'meta.effectiveDate and meta.dates.effective differ',
      ]);
    });

    it('is required in strict mode, in either form', async () => {
      const missing = await evaluateAt({}, true).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(missing).toBeInstanceOf(ValidationError);
      expect(missing).toMatchObject({
        message: 'effectiveDate is required in strict mode',
        reasons: [
          'meta.effectiveDate or meta.dates.effective must be provided when strict mode is enabled',
        ],
      });
      expect(
        (await evaluateAt({ dates: { effective: '2025-05-31' } }, true)).appliedRules,
      ).toHaveLength(1);
      expect(
        (await evaluateAt({ effectiveDate: new Date('2025-05-31T00:00:00Z') }, true)).appliedRules,
      ).toHaveLength(1);
    });
  });
});
