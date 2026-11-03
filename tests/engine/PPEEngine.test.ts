import { describe, it, expect, vi } from 'vitest';
import { EXCEPTION_MODEL } from '@run-iq/spec';
import type { OutputDeclaration } from '@run-iq/spec';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
// Imported from the package entry: both errors are public.
import { DecimalPrecisionError, OutputNotFiniteError, PluginHookError } from '../../src/index.js';
import { VERSION } from '../../src/utils/version.js';
import {
  makeRule,
  makeInput,
  StubModel,
  StubPlugin,
  StubDSL,
  InMemorySnapshotAdapter,
  ValueModel,
  permutations,
  expectSameFailure,
} from '../helpers.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { UnsealedResult } from '../../src/types/result.js';
import type { OutputValue } from '../../src/types/output.js';
import type { EvaluationInput } from '../../src/types/input.js';
import type { PPEPlugin } from '../../src/types/plugin.js';

describe('PPEEngine', () => {
  it('evaluates rules end-to-end', async () => {
    const model = new StubModel('M', 250);
    const plugin = new StubPlugin('test', [model]);
    const adapter = new InMemorySnapshotAdapter();

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());

    expect(result.value).toBe(250);
    expect(result.appliedRules).toHaveLength(1);
    expect(result.engineVersion).toBe(VERSION);
    expect(result).not.toHaveProperty('snapshotId');
    // The snapshot is still saved: the adapter answers `exists` for the requestId.
    expect(await adapter.exists(result.requestId)).toBe(true);
    expect(result.trace.steps).toHaveLength(1);
  });

  it('rejects invalid input', async () => {
    const engine = new PPEEngine({
      plugins: [],
      dsls: [],
      strict: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(engine.evaluate([], {} as any)).rejects.toThrow(ValidationError);
  });

  it('skips rules with checksum mismatch', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: false,
    });

    const rule = { ...makeRule({ id: 'r1', model: 'M', params: { x: 1 } }), checksum: 'bad' };
    const result = await engine.evaluate([rule], makeInput());

    expect(result.value).toBe(0);
    expect(result.skippedRules).toHaveLength(1);
    expect(result.skippedRules[0]!.reason).toBe('CHECKSUM_MISMATCH');
  });

  it('skips rules with unregistered DSL', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      strict: false,
    });

    const rule = makeRule({
      id: 'r1',
      model: 'M',
      params: {},
      condition: { dsl: 'nonexistent', value: {} },
    });

    const result = await engine.evaluate([rule], makeInput());
    expect(result.skippedRules).toHaveLength(1);
    expect(result.skippedRules[0]!.reason).toBe('DSL_NOT_FOUND');
  });

  it('records dslVersions in result', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);
    const dsl = new StubDSL('jsonlogic');

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [dsl],
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const result = await engine.evaluate(rules, makeInput());
    expect(result.dslVersions['jsonlogic']).toBe('1.0.0');
  });

  it('fails the evaluation when a plugin hook throws, and tells the plugin', async () => {
    const model = new StubModel('M', 100);

    const errorPlugin = new StubPlugin('erroring', [model]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (errorPlugin as any).beforeEvaluate = () => {
      throw new Error('hook crash');
    };

    const engine = new PPEEngine({
      plugins: [errorPlugin],
      dsls: [],
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    // Fail closed: no decision is returned without what the plugin was to prepare.
    const error = await engine.evaluate(rules, makeInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PluginHookError);
    expect(error).toMatchObject({
      plugin: 'erroring',
      hook: 'beforeEvaluate',
      message: 'plugin erroring beforeEvaluate failed: hook crash',
    });
    expect(errorPlugin.errors).toHaveLength(1);
    expectSameFailure(errorPlugin.errors[0], error);
  });

  it('applies native exceptions before evaluation and never evaluates an exception-only rule', async () => {
    const engine = new PPEEngine({
      plugins: [new StubPlugin('test', [new StubModel('M', 100)])],
      dsls: [],
      strict: false,
    });
    const exception = makeRule({
      id: 'X',
      model: EXCEPTION_MODEL,
      priority: 9000,
      exceptions: [{ kind: 'inhibit', targets: { ids: ['B'] } }],
    });
    const rules = [exception, makeRule({ id: 'A', model: 'M' }), makeRule({ id: 'B', model: 'M' })];
    const result = await engine.evaluate(rules, makeInput());
    expect(result.value).toBe(100);
    expect(result.appliedRules.map((r) => r.id)).toEqual(['A']);
    expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
      ['B', 'INHIBITED', 'inhibited by X@1'],
    ]);
  });

  it('supports dryRun mode (no snapshot saved)', async () => {
    const model = new StubModel('M', 100);
    const plugin = new StubPlugin('test', [model]);
    const adapter = new InMemorySnapshotAdapter();

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: true,
      dryRun: true,
    });

    const rules = [makeRule({ id: 'r1', model: 'M', params: {} })];
    const input = makeInput({ meta: { tenantId: 'tenant-1', effectiveDate: new Date() } });
    const result = await engine.evaluate(rules, input);
    expect(result.value).toBe(100);
    // In dryRun, snapshot adapter should not have been called
    expect(await adapter.exists('test-request-001')).toBe(false);
  });

  describe('malformed rules', () => {
    function engineWith(config: { strict?: boolean; onChecksumMismatch?: 'throw' | 'skip' } = {}) {
      return new PPEEngine({
        plugins: [new StubPlugin('test', [new StubModel('M', 100)])],
        dsls: [],
        strict: config.strict ?? false,
        ...(config.onChecksumMismatch ? { onChecksumMismatch: config.onChecksumMismatch } : {}),
      });
    }
    const dated = makeInput({ meta: { tenantId: 't', effectiveDate: new Date('2024-06-01') } });

    it('throws a ValidationError with onChecksumMismatch: throw', async () => {
      const malformed = { ...makeRule({ id: 'r1', model: 'M' }), version: 1.5 };
      const engine = engineWith({ onChecksumMismatch: 'throw' });
      await expect(engine.evaluate([malformed], dated)).rejects.toThrow(ValidationError);
      await expect(engine.evaluate([malformed], dated)).rejects.toThrow(/Invalid rule r1@1\.5/);
    });

    it('skips a rule without checksum and one with a non-string checksum as INVALID_RULE', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { checksum: _omit, ...absent } = makeRule({ id: 'absent', model: 'M' });
      const nonString = { ...makeRule({ id: 'num', model: 'M' }), checksum: 42 };
      const valid = makeRule({ id: 'ok', model: 'M' });
      const result = await engineWith().evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [absent as any, nonString as any, valid],
        dated,
      );
      expect(result.appliedRules.map((r) => r.id)).toEqual(['ok']);
      expect(result.skippedRules.map((s) => [s.rule.id, s.reason])).toEqual([
        ['absent', 'INVALID_RULE'],
        ['num', 'INVALID_RULE'],
      ]);
      expect(result.skippedRules[0]!.detail).toMatch(/^Invalid rule absent@1: .*checksum/);
      expect(result.skippedRules[1]!.detail).toMatch(/^Invalid rule num@1: .*checksum/);
    });

    it('behaves the same in strict mode', async () => {
      const malformed = {
        ...makeRule({ id: 'bad', model: 'M' }),
        effectiveUntil: new Date('2023-01-01'),
      };
      const valid = makeRule({ id: 'ok', model: 'M' });
      const result = await engineWith({ strict: true }).evaluate([malformed, valid], dated);
      expect(result.appliedRules.map((r) => r.id)).toEqual(['ok']);
      expect(result.skippedRules).toHaveLength(1);
      expect(result.skippedRules[0]!.reason).toBe('INVALID_RULE');
      expect(result.skippedRules[0]!.detail).toMatch(/^Invalid rule bad@1: .*window/);
    });
  });

  describe('typed outputs', () => {
    const RISK: OutputDeclaration = {
      type: 'enum',
      combine: 'highestPriority',
      values: ['low', 'high'],
    };
    const LIST: OutputDeclaration = { type: 'list', combine: 'union' };

    function engineWith(models: CalculationModel<OutputValue>[], dsls: DSLEvaluator[] = []) {
      return new PPEEngine({ plugins: [new StubPlugin('test', models)], dsls, strict: false });
    }

    it('combines every output by name and keeps value equal to outputs.value', async () => {
      const engine = engineWith([
        new StubModel('M', 0.1),
        new ValueModel('RISK', RISK, { hi: 'high', lo: 'low' }),
        new ValueModel('OBL', LIST, { o1: ['register'], o2: ['declare', 'register'] }),
      ]);
      const rules = [
        makeRule({ id: 'v1', model: 'M' }),
        makeRule({ id: 'v2', model: 'M' }),
        makeRule({ id: 'lo', model: 'RISK', output: 'risk', priority: 100 }),
        makeRule({ id: 'hi', model: 'RISK', output: 'risk', priority: 500 }),
        makeRule({ id: 'o1', model: 'OBL', output: 'obligations', priority: 100 }),
        makeRule({ id: 'o2', model: 'OBL', output: 'obligations', priority: 900 }),
      ];
      const result = await engine.evaluate(rules, makeInput());
      expect(result.outputs).toEqual({
        obligations: {
          name: 'obligations',
          type: 'list',
          combine: 'union',
          value: ['declare', 'register'],
          contributors: ['o2', 'o1'],
        },
        risk: {
          name: 'risk',
          type: 'enum',
          combine: 'highestPriority',
          value: 'high',
          contributors: ['hi'],
        },
        value: {
          name: 'value',
          type: 'number',
          combine: 'sum',
          value: 0.2,
          contributors: ['v1', 'v2'],
        },
      });
      expect(Object.keys(result.outputs)).toEqual(['obligations', 'risk', 'value']);
      expect(result.value).toBe(0.2);
      expect(result.appliedRules.map((r) => r.id)).toEqual(['o2', 'hi', 'lo', 'o1', 'v1', 'v2']);
    });

    it('gives value 0 and an empty value output when no rule feeds value', async () => {
      const engine = engineWith([new ValueModel('RISK', RISK, { r: 'low' })]);
      const result = await engine.evaluate(
        [makeRule({ id: 'r', model: 'RISK', output: 'risk' })],
        makeInput(),
      );
      expect(result.value).toBe(0);
      expect(result.outputs['value']).toEqual({
        name: 'value',
        type: 'number',
        combine: 'sum',
        value: 0,
        contributors: [],
      });
    });

    it('applies a short-circuit to its output only, naming its carrier as contributor', async () => {
      const engine = engineWith([
        new StubModel('M', 10),
        new ValueModel('RISK', RISK, { lo: 'low' }),
      ]);
      const rules = [
        makeRule({
          id: 'X',
          model: EXCEPTION_MODEL,
          priority: 9000,
          exceptions: [{ kind: 'shortCircuit', output: 'risk', value: 'high' }],
        }),
        makeRule({ id: 'lo', model: 'RISK', output: 'risk' }),
        makeRule({ id: 'v', model: 'M' }),
      ];
      const result = await engine.evaluate(rules, makeInput());
      expect(result.outputs['risk']).toEqual({
        name: 'risk',
        type: 'enum',
        combine: 'highestPriority',
        value: 'high',
        contributors: ['X'],
      });
      expect(result.value).toBe(10);
      expect(result.appliedRules.map((r) => r.id)).toEqual(['v']);
      expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
        ['lo', 'SHORT_CIRCUITED', 'output risk short-circuited by X@1'],
      ]);
      expect(result.trace.steps.map((s) => [s.ruleId, s.output, s.contribution])).toEqual([
        ['X', 'risk', 'high'],
        ['v', 'value', 10],
      ]);
    });

    it('excludes rules declaring one output differently, with both declarations in the detail', async () => {
      const engine = engineWith([
        new ValueModel('SCORED', RISK, { a: 'high' }),
        new ValueModel('LABELLED', { type: 'string', combine: 'highestPriority' }, { b: 'x' }),
      ]);
      const result = await engine.evaluate(
        [
          makeRule({ id: 'b', model: 'LABELLED', output: 'risk' }),
          makeRule({ id: 'a', model: 'SCORED', output: 'risk' }),
        ],
        makeInput(),
      );
      expect(result.outputs['risk']).toBeUndefined();
      expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
        [
          'a',
          'OUTPUT_MISMATCH',
          'rules feeding output risk declare it differently: a@1 enum/highestPriority (low, high); b@1 string/highestPriority',
        ],
        [
          'b',
          'OUTPUT_MISMATCH',
          'rules feeding output risk declare it differently: a@1 enum/highestPriority (low, high); b@1 string/highestPriority',
        ],
      ]);
    });

    it('refuses an overflowing amount instead of returning a partial decision', async () => {
      const plugin = new StubPlugin('test', [new StubModel('H', 1e308)]);
      const afterEvaluate = vi.fn((_input: EvaluationInput, _result: UnsealedResult) => undefined);
      const watcher: PPEPlugin = {
        name: 'watcher',
        version: '1.0.0',
        onInit: () => {},
        afterEvaluate,
      };
      const adapter = new InMemorySnapshotAdapter();
      const engine = new PPEEngine({
        plugins: [plugin, watcher],
        dsls: [],
        strict: false,
        snapshot: adapter,
      });
      const rules = [makeRule({ id: 'b', model: 'H' }), makeRule({ id: 'a', model: 'H' })];
      const input = makeInput();
      await expect(engine.evaluate(rules, input)).rejects.toThrow(OutputNotFiniteError);
      await expect(engine.evaluate(rules, input)).rejects.toThrow(
        'Output value is not a finite number; contributors: a, b',
      );
      expect(afterEvaluate).not.toHaveBeenCalled();
      expect(await adapter.exists(input.requestId)).toBe(false);
      // onError receives the engine error itself, once per failed evaluation.
      expect(plugin.errors).toHaveLength(2);
      expect(plugin.errors.every((e) => e instanceof OutputNotFiniteError)).toBe(true);
    });

    it('refuses an exact sum beyond a span of 1000 digits instead of a partial decision', async () => {
      const big = new ValueModel(
        'BIG',
        { type: 'decimal', combine: 'sum' },
        { a: `1${'0'.repeat(999)}`, b: '0.1' },
      );
      const plugin = new StubPlugin('test', [big]);
      const afterEvaluate = vi.fn((_input: EvaluationInput, _result: UnsealedResult) => undefined);
      const watcher: PPEPlugin = {
        name: 'watcher',
        version: '1.0.0',
        onInit: () => {},
        afterEvaluate,
      };
      const adapter = new InMemorySnapshotAdapter();
      const engine = new PPEEngine({
        plugins: [plugin, watcher],
        dsls: [],
        strict: false,
        snapshot: adapter,
      });
      const rules = [
        makeRule({ id: 'b', model: 'BIG', output: 'amount' }),
        makeRule({ id: 'a', model: 'BIG', output: 'amount' }),
      ];
      const input = makeInput();
      await expect(engine.evaluate(rules, input)).rejects.toThrow(DecimalPrecisionError);
      await expect(engine.evaluate(rules, input)).rejects.toThrow(
        'Output amount holds a decimal spanning more than 1000 digits: the decision is refused rather than rounded',
      );
      expect(afterEvaluate).not.toHaveBeenCalled();
      expect(await adapter.exists(input.requestId)).toBe(false);
      expect(plugin.errors).toHaveLength(2);
      expect(plugin.errors.every((e) => e instanceof DecimalPrecisionError)).toBe(true);
    });

    it('refuses a short-circuit beyond a span of 1000 digits instead of a partial decision', async () => {
      const amount = new ValueModel('AMOUNT', { type: 'decimal', combine: 'max' }, { a: '1' });
      const afterEvaluate = vi.fn((_input: EvaluationInput, _result: UnsealedResult) => undefined);
      const watcher: PPEPlugin = {
        name: 'watcher',
        version: '1.0.0',
        onInit: () => {},
        afterEvaluate,
      };
      const adapter = new InMemorySnapshotAdapter();
      const engine = new PPEEngine({
        plugins: [new StubPlugin('test', [amount]), watcher],
        dsls: [],
        strict: false,
        snapshot: adapter,
      });
      const rules = [
        makeRule({
          id: 'X',
          model: EXCEPTION_MODEL,
          priority: 9000,
          exceptions: [{ kind: 'shortCircuit', output: 'amount', value: `1${'0'.repeat(999)}.1` }],
        }),
        makeRule({ id: 'a', model: 'AMOUNT', output: 'amount' }),
      ];
      const input = makeInput();
      await expect(engine.evaluate(rules, input)).rejects.toThrow(DecimalPrecisionError);
      expect(afterEvaluate).not.toHaveBeenCalled();
      expect(await adapter.exists(input.requestId)).toBe(false);
    });

    it('normalizes and rounds a short-circuit of a decimal output', async () => {
      const amount = new ValueModel(
        'AMOUNT',
        { type: 'decimal', combine: 'sum', rounding: { scale: 1, mode: 'halfEven' } },
        { a: '1' },
      );
      const engine = engineWith([amount]);
      const result = await engine.evaluate(
        [
          makeRule({
            id: 'X',
            model: EXCEPTION_MODEL,
            priority: 9000,
            exceptions: [{ kind: 'shortCircuit', output: 'amount', value: '0002.25' }],
          }),
          makeRule({ id: 'a', model: 'AMOUNT', output: 'amount' }),
        ],
        makeInput(),
      );
      expect(result.outputs['amount']).toEqual({
        name: 'amount',
        type: 'decimal',
        combine: 'sum',
        value: '2.2',
        contributors: ['X'],
      });
      expect(result.trace.steps.map((s) => [s.ruleId, s.contribution])).toEqual([['X', '2.25']]);
    });

    it('rethrows the engine error when onError itself fails', async () => {
      const failing: PPEPlugin = {
        name: 'failing',
        version: '1.0.0',
        onInit: (context) => context.modelRegistry.register(new StubModel('H', 1e308)),
        onError: () => {
          throw new Error('onError crash');
        },
      };
      const engine = new PPEEngine({ plugins: [failing], dsls: [], strict: false });
      const rules = [makeRule({ id: 'b', model: 'H' }), makeRule({ id: 'a', model: 'H' })];
      await expect(engine.evaluate(rules, makeInput())).rejects.toThrow(OutputNotFiniteError);
    });

    it('refuses at construction a plugin model with an invalid output declaration', () => {
      // Invalid on purpose: only JSON.parse builds it untyped.
      const bad = new ValueModel('BAD', JSON.parse('{"type":"string","combine":"sum"}'), {});
      // The registry's refusal happens inside the plugin's `onInit`, so it reaches the caller as the
      // engine's PluginHookError holding the refusal, never as an error a plugin could have built.
      let error: unknown;
      try {
        engineWith([bad]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PluginHookError);
      expect(error).toMatchObject({ hook: 'onInit' });
      expect((error as PluginHookError).cause).toMatchObject({ name: 'InvalidModelError' });
    });

    it('keeps value a number: a rule feeding it with a boolean declaration is excluded', async () => {
      const engine = engineWith([
        new ValueModel('B', { type: 'boolean', combine: 'all' }, { a: true }),
      ]);
      const result = await engine.evaluate([makeRule({ id: 'a', model: 'B' })], makeInput());
      expect(result.value).toBe(0);
      expect(result.skippedRules.map((s) => [s.rule.id, s.reason])).toEqual([
        ['a', 'OUTPUT_MISMATCH'],
      ]);
    });

    it('reports the missing facts and the filter diagnostics', async () => {
      const facts: DSLEvaluator = {
        dsl: 'facts',
        version: '1.0.0',
        evaluate: () => true,
        listVariables: (expression) => {
          if (expression === 'broken') throw new Error('cannot parse');
          return ['/amount', '/income/total', '/household/size'];
        },
      };
      const engine = engineWith([new StubModel('M', 1)], [facts]);
      const result = await engine.evaluate(
        [
          makeRule({ id: 'a', model: 'M', condition: { dsl: 'facts', value: 'ok' } }),
          makeRule({ id: 'b', model: 'M', condition: { dsl: 'facts', value: 'broken' } }),
        ],
        makeInput(),
      );
      expect(result.missingFacts).toEqual(['/household/size', '/income/total']);
      expect(result.diagnostics).toEqual([
        { source: 'engine', message: 'listVariables of facts for b@1 failed: cannot parse' },
      ]);
    });

    it('gives the same decision whatever the order of the rules', async () => {
      const engine = engineWith(
        [
          new StubModel('M', 0.1),
          new ValueModel('OBL', LIST, { d1: ['b', 'a'], d2: ['z'], o: ['a', 'c'] }),
        ],
        [new StubDSL('never', false)],
      );
      const rules = [
        makeRule({
          id: 'X',
          model: EXCEPTION_MODEL,
          priority: 9000,
          exceptions: [{ kind: 'inhibit', targets: { ids: ['i'] } }],
        }),
        makeRule({ id: 'i', model: 'M' }),
        makeRule({
          id: 'd1',
          model: 'OBL',
          output: 'obligations',
          dominanceGroup: 'g',
          priority: 500,
        }),
        makeRule({
          id: 'd2',
          model: 'OBL',
          output: 'obligations',
          dominanceGroup: 'g',
          priority: 100,
        }),
        makeRule({ id: 'o', model: 'OBL', output: 'obligations', priority: 500 }),
        makeRule({ id: 'no', model: 'M', condition: { dsl: 'never', value: null } }),
        makeRule({ id: 'v', model: 'M' }),
      ];
      const project = (r: UnsealedResult): unknown => ({
        outputs: r.outputs,
        outputNames: Object.keys(r.outputs),
        applied: r.appliedRules.map((x) => x.id),
        skipped: r.skippedRules.map((s) => [s.rule.id, s.reason, s.detail]),
        breakdown: r.breakdown.map((b) => [b.ruleId, b.output, b.contribution]),
        trace: r.trace.steps.map((s) => [s.ruleId, s.output, s.contribution]),
        missingFacts: r.missingFacts,
      });
      const expected = project(await engine.evaluate(rules, makeInput()));
      expect(expected).toEqual({
        outputs: {
          obligations: {
            name: 'obligations',
            type: 'list',
            combine: 'union',
            value: ['b', 'a', 'c'],
            contributors: ['d1', 'o'],
          },
          value: { name: 'value', type: 'number', combine: 'sum', value: 0.1, contributors: ['v'] },
        },
        outputNames: ['obligations', 'value'],
        applied: ['d1', 'o', 'v'],
        skipped: [
          ['d2', 'DOMINATED', 'dominated by d1@1 (priority 500) in group g'],
          ['i', 'INHIBITED', 'inhibited by X@1'],
          ['no', 'CONDITION_FALSE', 'condition evaluated to false'],
        ],
        breakdown: [
          ['d1', 'obligations', ['b', 'a']],
          ['o', 'obligations', ['a', 'c']],
          ['v', 'value', 0.1],
        ],
        trace: [
          ['d1', 'obligations', ['b', 'a']],
          ['o', 'obligations', ['a', 'c']],
          ['v', 'value', 0.1],
        ],
        missingFacts: [],
      });
      for (const order of permutations(rules)) {
        expect(project(await engine.evaluate(order, makeInput()))).toEqual(expected);
      }
    }, 30_000);
  });
});
