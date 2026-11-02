import { describe, it, expect } from 'vitest';
import { SpecError } from '@run-iq/spec';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import { makeRule, makeInput, StubModel } from '../helpers.js';

const host: PPEPlugin = {
  name: 'model-host',
  version: '1.0.0',
  onInit(context: PluginContext): void {
    context.modelRegistry.register(new StubModel('M', 100));
  },
};

const engine = (plugins: PPEPlugin[] = []): PPEEngine =>
  new PPEEngine({ plugins: [host, ...plugins], dsls: [], strict: false });

describe('the evaluation date is an input, a rule bound is a rule', () => {
  it('an invalid meta.effectiveDate rejects the evaluation with spec INVALID_DATE, unchanged', async () => {
    const input = makeInput({ meta: { tenantId: 't', effectiveDate: new Date('x') } });
    const error = await engine()
      .evaluate([makeRule({ id: 'r1', model: 'M' })], input)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(SpecError);
    expect(error).toMatchObject({ code: 'INVALID_DATE', message: 'at must be a valid Date' });
  });

  it('a bound a hook corrupts skips that rule only, the others are applied', async () => {
    const corrupt: PPEPlugin = {
      name: 'corrupt',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: (input, rules) => ({
        input,
        rules: rules.map((r) => (r.id === 'bad' ? { ...r, effectiveUntil: new Date('x') } : r)),
      }),
    };
    const result = await engine([corrupt]).evaluate(
      [makeRule({ id: 'bad', model: 'M' }), makeRule({ id: 'good', model: 'M' })],
      makeInput({ meta: { tenantId: 't', effectiveDate: new Date('2025-06-01T00:00:00.000Z') } }),
    );
    expect(result.appliedRules.map((r) => r.id)).toEqual(['good']);
    expect(result.value).toBe(100);
    expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
      [
        'bad',
        'INVALID_RULE',
        'Invalid rule bad@1: INVALID_DATE: effectiveUntil must be a Date, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS[.sss] with Z or ±HH:MM, in the years 0000 to 9999; got an invalid Date',
      ],
    ]);
  });
});
