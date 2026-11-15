import { describe, it, expect } from 'vitest';
import { EXCEPTION_MODEL } from '@run-iq/spec';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import type { PPEPlugin } from '../../src/types/plugin.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { Rule } from '../../src/types/rule.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// 9M1 sub-PR 1, R44 (skip rows), R8, R6: every skip the engine writes has a proofDetail built from
// labels, names, pointers, codes and the rule's own bounds only. The distinctive value of the input
// (`SECRET`) never appears in any proofDetail (MC5, for the rows of this sub-PR).

const SECRET = 'Zx9-secret-value';

const host: PPEPlugin = {
  name: 'host',
  version: '1.0.0',
  onInit(context) {
    context.modelRegistry.register(new StubModel('m', 5));
  },
};
const dslFalse: DSLEvaluator = { dsl: 'no', version: '1.0.0', evaluate: () => false };

const run = async (
  rules: Rule[],
  input = makeInput(),
  config: Partial<ConstructorParameters<typeof PPEEngine>[0]> = {},
  plugins: PPEPlugin[] = [],
) =>
  new PPEEngine({
    plugins: [host, ...plugins],
    dsls: [dslFalse],
    strict: false,
    snapshot: new InMemorySnapshotAdapter(),
    ...config,
  }).evaluate(rules, input);

const only = (result: Awaited<ReturnType<typeof run>>, id: string) => {
  const skip = result.skippedRules.find((s) => s.rule.id === id);
  expect(skip, `${id} is skipped`).toBeDefined();
  return skip as NonNullable<typeof skip>;
};

describe('R44: the proofDetail of each skip row', () => {
  it("INACTIVE_DATE: the rule's own bounds, never the date of the input", async () => {
    const result = await run(
      [
        makeRule({
          id: 'old',
          model: 'm',
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          effectiveUntil: new Date('2021-01-01T00:00:00Z'),
        }),
      ],
      makeInput({ meta: { tenantId: 't', effectiveDate: '2026-06-01T00:00:00.000Z' } }),
    );
    expect(only(result, 'old').reason).toBe('INACTIVE_DATE');
    expect(only(result, 'old').proofDetail).toBe(
      'window [2020-01-01T00:00:00.000Z, 2021-01-01T00:00:00.000Z) does not contain /$dates/effective (UTC)',
    );
  });

  it('INACTIVE_DATE with no end: the open end is written ∞', async () => {
    const result = await run(
      [makeRule({ id: 'future', model: 'm', effectiveFrom: new Date('2030-01-01T00:00:00Z') })],
      makeInput({ meta: { tenantId: 't', effectiveDate: '2026-06-01T00:00:00.000Z' } }),
    );
    expect(only(result, 'future').proofDetail).toBe(
      'window [2030-01-01T00:00:00.000Z, ∞) does not contain /$dates/effective (UTC)',
    );
  });

  it("TAG_MISMATCH: the rule's tags and the pointer of the input tags, never the input tags", async () => {
    const result = await run(
      [makeRule({ id: 'tagged', model: 'm', tags: ['alpha', 'beta'] })],
      makeInput({ meta: { tenantId: 't', tags: [SECRET] } }),
    );
    expect(only(result, 'tagged').reason).toBe('TAG_MISMATCH');
    expect(only(result, 'tagged').proofDetail).toBe('tags: rule [alpha, beta], input /meta/tags');
    expect(only(result, 'tagged').detail).toContain(SECRET);
  });

  it("DIMENSION_MISMATCH: the rule's spec and the pointer, never the input value", async () => {
    const result = await run(
      [makeRule({ id: 'dim', model: 'm', dimensions: { country: 'TG' } })],
      makeInput({ meta: { tenantId: 't', dimensions: { country: SECRET } } }),
    );
    expect(only(result, 'dim').reason).toBe('DIMENSION_MISMATCH');
    expect(only(result, 'dim').proofDetail).toBe('country: rule TG, input /$dimensions/country');
  });

  it('DIMENSION_MISMATCH for an absent dimension names the same pointer', async () => {
    const result = await run(
      [makeRule({ id: 'dim', model: 'm', dimensions: { country: 'TG' } })],
      makeInput({ meta: { tenantId: 't', dimensions: { sector: 'x' } } }),
    );
    expect(only(result, 'dim').proofDetail).toBe('country: rule TG, input /$dimensions/country');
  });

  it('CONDITION_FALSE', async () => {
    const result = await run([
      makeRule({ id: 'cond', model: 'm', condition: { dsl: 'no', value: { any: SECRET } } }),
    ]);
    expect(only(result, 'cond').reason).toBe('CONDITION_FALSE');
    expect(only(result, 'cond').proofDetail).toBe('condition evaluated to false');
  });

  it('DOMINATED and RULE_CONFLICT: equal to the detail, built from labels and priorities', async () => {
    const dominated = await run([
      makeRule({ id: 'hi', model: 'm', priority: 3000, dominanceGroup: 'g' }),
      makeRule({ id: 'lo', model: 'm', priority: 1000, dominanceGroup: 'g' }),
    ]);
    expect(only(dominated, 'lo').reason).toBe('DOMINATED');
    expect(only(dominated, 'lo').proofDetail).toBe(only(dominated, 'lo').detail);
    expect(only(dominated, 'lo').proofDetail).toBe('dominated by hi@1 (priority 3000) in group g');
    const tied = await run(
      [
        makeRule({ id: 'a', model: 'm', priority: 100, dominanceGroup: 'g' }),
        makeRule({ id: 'b', model: 'm', priority: 100, dominanceGroup: 'g' }),
      ],
      makeInput(),
      { onConflict: 'first' },
    );
    expect(only(tied, 'b').reason).toBe('RULE_CONFLICT');
    expect(only(tied, 'b').proofDetail).toBe(only(tied, 'b').detail);
  });

  it('INHIBITED and SHORT_CIRCUITED: equal to the detail', async () => {
    const inhibitor = makeRule({
      id: 'X',
      model: EXCEPTION_MODEL,
      priority: 9000,
      exceptions: [{ kind: 'inhibit', targets: { ids: ['victim'] } }],
    });
    const inhibited = await run([inhibitor, makeRule({ id: 'victim', model: 'm' })]);
    expect(only(inhibited, 'victim').reason).toBe('INHIBITED');
    expect(only(inhibited, 'victim').proofDetail).toBe('inhibited by X@1');
    const shorting = makeRule({
      id: 'SC',
      model: EXCEPTION_MODEL,
      priority: 9000,
      exceptions: [{ kind: 'shortCircuit', output: 'value', value: 7 }],
    });
    const short = await run([shorting, makeRule({ id: 'feeder', model: 'm' })]);
    expect(only(short, 'feeder').reason).toBe('SHORT_CIRCUITED');
    expect(only(short, 'feeder').proofDetail).toBe(only(short, 'feeder').detail);
    expect(only(short, 'feeder').proofDetail).toBe('output value short-circuited by SC@1');
  });

  it("PLUGIN: the plugin's name, never its words", async () => {
    const skipper: PPEPlugin = {
      name: 'skipper',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [],
        skipped: [{ rule: rules[0] as Rule, reason: 'PLUGIN', detail: `because of ${SECRET}` }],
      }),
    };
    const result = await run([makeRule({ id: 'p', model: 'm' })], makeInput(), {}, [skipper]);
    expect(only(result, 'p').reason).toBe('PLUGIN');
    expect(only(result, 'p').detail).toBe(`plugin skipper: because of ${SECRET}`);
    expect(only(result, 'p').proofDetail).toBe('skipped by plugin skipper');
  });

  it('the malformed-rule rows carry the cause and the label only', async () => {
    const bad = { ...makeRule({ id: 'bad', model: 'm' }), checksum: 'f'.repeat(64) };
    const result = await run([bad], makeInput(), { onChecksumMismatch: 'skip' });
    expect(only(result, 'bad').proofDetail).toBe(
      'CHECKSUM_MISMATCH: the checksum of bad@1 does not match its content',
    );
  });

  it('every skip the engine writes has a string proofDetail with no input value', async () => {
    const result = await run(
      [
        makeRule({ id: 'tag', model: 'm', tags: ['t'] }),
        makeRule({ id: 'dim', model: 'm', dimensions: { country: 'TG' } }),
        makeRule({ id: 'cond', model: 'm', condition: { dsl: 'no', value: {} } }),
        makeRule({ id: 'nodsl', model: 'm', condition: { dsl: 'missing', value: {} } }),
      ],
      makeInput({
        data: { secret: SECRET },
        meta: { tenantId: 't', tags: [SECRET], dimensions: { country: SECRET } },
      }),
    );
    expect(result.skippedRules.length).toBeGreaterThanOrEqual(4);
    for (const skip of result.skippedRules) {
      expect(typeof skip.proofDetail, skip.rule.id).toBe('string');
      expect(skip.proofDetail.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(result.skippedRules.map((s) => s.proofDetail))).not.toContain(SECRET);
  });
});

describe('R8: a plugin skip carries no proofDetail', () => {
  it('a hook skip with a proofDetail key is refused with a PluginHookError (unknown key)', async () => {
    const forging: PPEPlugin = {
      name: 'forger',
      version: '1.0.0',
      onInit: () => undefined,
      beforeEvaluate: (input, rules) =>
        ({
          input,
          rules: [],
          skipped: [{ rule: rules[0], reason: 'PLUGIN', proofDetail: 'forged' }],
        }) as never,
    };
    const error = await run([makeRule({ id: 'p', model: 'm' })], makeInput(), {}, [forging]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PluginHookError);
  });
});

describe('R6: the outputs carry a status and a list of pending rules', () => {
  it('every output is determined with no pending rule, and `value` is a member', async () => {
    const result = await run([
      makeRule({ id: 'a', model: 'm' }),
      makeRule({ id: 'b', model: 'm' }),
    ]);
    const output = result.outputs['value'];
    expect(output).toMatchObject({
      name: 'value',
      status: 'determined',
      pending: [],
      contributors: ['a', 'b'],
    });
    expect(Object.hasOwn(output as object, 'value')).toBe(true);
    expect(output?.value).toBe(result.value);
  });

  it('the default output with no feeder is determined 0', async () => {
    const result = await run(
      [makeRule({ id: 'tag', model: 'm', tags: ['t'] })],
      makeInput({ meta: { tenantId: 't', tags: ['x'] } }),
    );
    expect(result.outputs['value']).toEqual({
      name: 'value',
      type: 'number',
      combine: 'sum',
      value: 0,
      status: 'determined',
      contributors: [],
      pending: [],
    });
  });
});

describe('R44: the proofDetail of the faults that become pending in the next sub-PR', () => {
  const strictModel = {
    name: 'strict',
    version: '1.0.0',
    validateParams: (params: unknown) => {
      const amount = (params as { amount?: number }).amount;
      if (amount === 999) return 'not a result' as never; // a breach of the contract
      return amount !== undefined && amount > 0
        ? { valid: true }
        : { valid: false, errors: [`bad ${SECRET}`] };
    },
    calculate: () => 1,
  };
  const withStrict: PPEPlugin = {
    name: 'strict-host',
    version: '1.0.0',
    onInit(context) {
      context.modelRegistry.register(strictModel as never);
    },
  };
  const carrierOf = (amount: number): Rule =>
    makeRule({
      id: 'C',
      model: EXCEPTION_MODEL,
      priority: 9000,
      exceptions: [{ kind: 'substitute', targets: { ids: ['T'] }, params: { amount } }],
    });

  it('a substitution the model refuses: the model, the rules, the cause', async () => {
    const result = await run(
      [carrierOf(-1), makeRule({ id: 'T', model: 'strict', params: { amount: 5 } })],
      makeInput(),
      {},
      [withStrict],
    );
    expect(only(result, 'T').reason).toBe('INVALID_PARAMS');
    expect(only(result, 'T').proofDetail).toBe(
      'INVALID_PARAMS: model strict refused the params of T@1 after substitution by C@1',
    );
    expect(only(result, 'T').proofDetail).not.toContain(SECRET);
    expect(only(result, 'T').detail).toContain(SECRET);
  });

  it('a validateParams that breaks its contract after a substitution', async () => {
    const result = await run(
      [carrierOf(999), makeRule({ id: 'T', model: 'strict', params: { amount: 5 } })],
      makeInput(),
      {},
      [withStrict],
    );
    expect(only(result, 'T').reason).toBe('MODEL_ERROR');
    expect(only(result, 'T').proofDetail).toBe(
      'MODEL_ERROR: model strict of T@1 broke its contract in validateParams after substitution by C@1',
    );
  });

  it('a malformed rule names its label and the places, a refused window its code', async () => {
    const odd = {
      ...makeRule({ id: 'odd', model: 'm' }),
      params: { x: new Map() },
    } as unknown as Rule;
    const malformed = await run([odd]);
    expect(only(malformed, 'odd').reason).toBe('INVALID_RULE');
    expect(only(malformed, 'odd').proofDetail).toMatch(
      /^INVALID_RULE: rule odd@1 is malformed at \/params\/x$/,
    );
    // (makeRule refuses an empty window itself: the rule is built valid, then its end is moved)
    const backwards = {
      ...makeRule({ id: 'win', model: 'm', effectiveFrom: new Date('2026-01-01T00:00:00Z') }),
      effectiveUntil: '2025-01-01T00:00:00.000Z',
    } as unknown as Rule;
    const window = await run([backwards]);
    expect(only(window, 'win').reason).toBe('INVALID_RULE');
    expect(only(window, 'win').proofDetail).toMatch(
      /^INVALID_RULE: rule win@1 (has an invalid window \([A-Z_]+\)|is malformed \([A-Z_]+\))$/,
    );
  });

  it('a model that writes into its arguments, and a rule with no DSL', async () => {
    const writer: PPEPlugin = {
      name: 'writer',
      version: '1.0.0',
      onInit(context) {
        context.modelRegistry.register({
          name: 'writer',
          version: '1.0.0',
          validateParams: () => ({ valid: true }),
          calculate: (_i: unknown, _r: unknown, params: Record<string, unknown>) => {
            params[SECRET] = 1;
            return 1;
          },
        } as never);
      },
    };
    const result = await run(
      [makeRule({ id: 'w', model: 'writer', params: {} })],
      makeInput(),
      {},
      [writer],
    );
    expect(only(result, 'w').reason).toBe('MODEL_ERROR');
    expect(only(result, 'w').proofDetail).toBe(
      'MODEL_ERROR: model writer of w@1 wrote to its input',
    );
    expect(only(result, 'w').proofDetail).not.toContain(SECRET);
    const noDsl = await run([
      makeRule({ id: 'n', model: 'm', condition: { dsl: 'missing', value: {} } }),
    ]);
    expect(only(noDsl, 'n').proofDetail).toBe('DSL_NOT_FOUND: DSL missing is not registered');
  });

  it('a DSL that throws: the cause, the label and the DSL, never its message', async () => {
    const throwing: DSLEvaluator = {
      dsl: 'boom',
      version: '1.0.0',
      evaluate: () => {
        throw new Error(`boom ${SECRET}`);
      },
    };
    const result = await run(
      [makeRule({ id: 'd', model: 'm', condition: { dsl: 'boom', value: {} } })],
      makeInput(),
      {
        dsls: [throwing],
      },
    );
    expect(only(result, 'd').reason).toBe('DSL_ERROR');
    expect(only(result, 'd').proofDetail).toBe(
      'DSL_ERROR: the condition of d@1 failed in DSL boom',
    );
  });
});
