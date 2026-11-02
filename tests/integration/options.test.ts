import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import type { EvaluateOptions } from '../../src/types/options.js';
import { makeRule, makeInput, StubModel, StubPlugin } from '../helpers.js';

const engine = (): PPEEngine =>
  new PPEEngine({
    plugins: [new StubPlugin('test', [new StubModel('M', 10)])],
    dsls: [],
    strict: false,
  });

const rules = [makeRule({ id: 'r1', model: 'M' })];

const refusal = async (options: unknown): Promise<ValidationError> => {
  try {
    await engine().evaluate(rules, makeInput(), options as EvaluateOptions);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  return expect.unreachable('should have thrown');
};

describe('evaluate(rules, input, options)', () => {
  it('refuses an option it does not know', async () => {
    const error = await refusal({ foo: 1 });
    expect(error.message).toBe('Invalid evaluate options');
    expect(error.reasons).toEqual(['unknown evaluate option: foo']);
  });

  it('names every unknown option, in the order given', async () => {
    expect((await refusal({ b: 1, requested: ['value'], a: 2 })).reasons).toEqual([
      'unknown evaluate option: b',
      'unknown evaluate option: a',
    ]);
  });

  it('refuses an unknown option whatever its value, undefined included', async () => {
    // A misspelled name whose value comes from an unset variable is still a misspelling.
    expect((await refusal({ requestd: undefined })).reasons).toEqual([
      'unknown evaluate option: requestd',
    ]);
  });

  it('refuses options that are not an object', async () => {
    for (const bad of [null, 3, 'x', []]) {
      expect((await refusal(bad)).reasons).toEqual(['evaluate options must be an object']);
    }
  });

  it('accepts no options, an empty object, and an option whose value is undefined', async () => {
    const e = engine();
    await e.evaluate(rules, makeInput({ requestId: 'a' }));
    await e.evaluate(rules, makeInput({ requestId: 'b' }), {});
    await e.evaluate(rules, makeInput({ requestId: 'c' }), { requested: undefined });
    // A known name whose value is undefined is absent.
    await e.evaluate(rules, makeInput({ requestId: 'd' }), { supersedes: undefined });
  });

  describe('the options of the plan are accepted and, in 9L, inert', () => {
    // Each field is wired by its own task; until then the decision is the one without options.
    const project = (r: Awaited<ReturnType<PPEEngine['evaluate']>>): unknown => ({
      value: r.value,
      outputs: r.outputs,
      applied: r.appliedRules.map((rule) => rule.id),
      skipped: r.skippedRules,
      missingFacts: r.missingFacts,
      diagnostics: r.diagnostics,
    });

    it('requested, referentials, ruleSets and supersedes change nothing yet', async () => {
      const without = await engine().evaluate(rules, makeInput({ requestId: 'x' }));
      const options: EvaluateOptions = {
        requested: ['value'],
        referentials: [],
        ruleSets: [{ kind: 'local' }, { kind: 'pack', id: 'p', version: '1', digest: 'd' }],
        supersedes: { digest: 'a'.repeat(64), reason: 'correction' },
      };
      const withOptions = await engine().evaluate(rules, makeInput({ requestId: 'x' }), options);
      expect(project(withOptions)).toEqual(project(without));
      expect(withOptions.value).toBe(10);
    });
  });
});
