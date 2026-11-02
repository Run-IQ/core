import { describe, it, expect, vi } from 'vitest';
import { readsOf } from '../../src/context/reads.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import { makeRule } from '../helpers.js';

/** A DSL that reads what it is told to read, or fails as it is told to. */
function dslReading(read: unknown, name = 'test'): DSLEvaluator {
  return {
    dsl: name,
    version: '1.0.0',
    evaluate: () => true,
    listVariables: () => read as string[],
  };
}

function modelReading(read: unknown, name = 'M'): CalculationModel {
  return {
    name,
    version: '1.0.0',
    validateParams: () => ({ valid: true }),
    calculate: () => 0,
    listVariables: () => read as string[],
  };
}

const withCondition = makeRule({ id: 'R1', model: 'M', condition: { dsl: 'test', value: ['x'] } });
const noCondition = makeRule({ id: 'R1', model: 'M' });

describe('readsOf', () => {
  it('lists the pointers read and the outputs among them, in order of appearance', () => {
    const dsl = dslReading([
      '/revenue/total',
      '/$outputs/risque/niveau',
      '/$outputs/rgpd:profilage',
      '/$dates/effective',
    ]);
    expect(readsOf(withCondition, dsl, modelReading([]))).toEqual({
      pointers: [
        '/revenue/total',
        '/$outputs/risque/niveau',
        '/$outputs/rgpd:profilage',
        '/$dates/effective',
      ],
      outputs: ['risque', 'rgpd:profilage'],
      declared: true,
      problems: [],
    });
  });

  it('makes $outputs, $bounds and $selected of one output the read of that output', () => {
    const dsl = dslReading(['/$bounds/prime/min', '/$selected/prime/ruleId', '/$outputs/total']);
    expect(readsOf(withCondition, dsl, modelReading([])).outputs).toEqual(['prime', 'total']);
  });

  it('does not name an output for the root of $outputs, or for another variable', () => {
    const dsl = dslReading(['/$outputs', '/$dates/effective', '/$dimensions/pays', '/$item/age']);
    const reads = readsOf(withCondition, dsl, modelReading([]));
    expect(reads.outputs).toEqual([]);
    expect(reads.pointers).toHaveLength(4);
  });

  it('joins the reads of the condition and of the model, without repeating a pointer', () => {
    const reads = readsOf(
      withCondition,
      dslReading(['/a', '/b']),
      modelReading(['/b', '/c', '/$outputs/x']),
    );
    expect(reads.pointers).toEqual(['/a', '/b', '/c', '/$outputs/x']);
    expect(reads.outputs).toEqual(['x']);
    expect(reads.declared).toBe(true);
  });

  it('hands the model the params of the rule and the DSL the expression of the condition', () => {
    const dslRead = vi.fn(() => []);
    const modelRead = vi.fn(() => []);
    const rule = makeRule({
      id: 'R1',
      model: 'M',
      params: { rate: 0.2 },
      condition: { dsl: 'test', value: { var: 'x' } },
    });
    readsOf(
      rule,
      { ...dslReading([]), listVariables: dslRead },
      { ...modelReading([]), listVariables: modelRead },
    );
    expect(dslRead).toHaveBeenCalledWith({ var: 'x' });
    expect(modelRead).toHaveBeenCalledWith({ rate: 0.2 });
  });

  it('does not ask the DSL about a rule that has no condition', () => {
    const dslRead = vi.fn(() => ['/never']);
    const reads = readsOf(
      noCondition,
      { ...dslReading([]), listVariables: dslRead },
      modelReading(['/m']),
    );
    expect(dslRead).not.toHaveBeenCalled();
    expect(reads).toEqual({ pointers: ['/m'], outputs: [], declared: true, problems: [] });
  });

  describe('what is not declared', () => {
    it('a DSL without listVariables leaves the reads undeclared, with no problem', () => {
      const dsl: DSLEvaluator = { dsl: 'test', version: '1.0.0', evaluate: () => true };
      expect(readsOf(withCondition, dsl, modelReading(['/m']))).toEqual({
        pointers: ['/m'],
        outputs: [],
        declared: false,
        problems: [],
      });
    });

    it('a model without listVariables leaves the reads undeclared, with no problem', () => {
      const model: CalculationModel = {
        name: 'M',
        version: '1.0.0',
        validateParams: () => ({ valid: true }),
        calculate: () => 0,
      };
      expect(readsOf(withCondition, dslReading(['/a']), model)).toEqual({
        pointers: ['/a'],
        outputs: [],
        declared: false,
        problems: [],
      });
    });

    it('an unknown DSL or model leaves the reads undeclared', () => {
      expect(readsOf(withCondition, undefined, modelReading([])).declared).toBe(false);
      expect(readsOf(noCondition, undefined, undefined).declared).toBe(false);
    });

    it('a rule without condition does not need a DSL to be declared', () => {
      expect(readsOf(noCondition, undefined, modelReading([])).declared).toBe(true);
    });
  });

  describe('a listVariables that does not conform (D-39)', () => {
    it('a dotted path is a non-pointer: named, the rest kept, the rule undeclared', () => {
      const reads = readsOf(withCondition, dslReading(['/ok', 'revenue.total']), modelReading([]));
      expect(reads).toEqual({
        pointers: ['/ok'],
        outputs: [],
        declared: false,
        problems: [
          {
            kind: 'non-pointer',
            message: 'listVariables of test for R1@1 returned a non-pointer: revenue.total',
          },
        ],
      });
    });

    it('a value that is not a string is a non-pointer, written as JSON', () => {
      const reads = readsOf(withCondition, dslReading([42, { a: 1 }, null]), modelReading([]));
      expect(reads.problems.map((p) => p.message)).toEqual([
        'listVariables of test for R1@1 returned a non-pointer: 42',
        'listVariables of test for R1@1 returned a non-pointer: {"a":1}',
        'listVariables of test for R1@1 returned a non-pointer: null',
      ]);
      expect(reads.declared).toBe(false);
    });

    it('a pointer with a bad escape is a non-pointer', () => {
      const reads = readsOf(withCondition, dslReading(['/a~2b']), modelReading([]));
      expect(reads.problems).toEqual([
        {
          kind: 'non-pointer',
          message: 'listVariables of test for R1@1 returned a non-pointer: /a~2b',
        },
      ]);
    });

    it('a listVariables that throws reads nothing, and says why', () => {
      const dsl: DSLEvaluator = {
        ...dslReading([]),
        listVariables: () => {
          throw new Error('boom');
        },
      };
      expect(readsOf(withCondition, dsl, modelReading(['/m']))).toEqual({
        pointers: ['/m'],
        outputs: [],
        declared: false,
        problems: [{ kind: 'failed', message: 'listVariables of test for R1@1 failed: boom' }],
      });
    });

    it('a lazy list that throws midway contributes nothing', () => {
      const dsl: DSLEvaluator = {
        ...dslReading([]),
        listVariables: function* () {
          yield '/first';
          throw new Error('midway');
        } as unknown as NonNullable<DSLEvaluator['listVariables']>,
      };
      const reads = readsOf(withCondition, dsl, modelReading([]));
      expect(reads.pointers).toEqual([]);
      expect(reads.problems).toEqual([
        { kind: 'failed', message: 'listVariables of test for R1@1 failed: midway' },
      ]);
    });

    it('a result that is not a list is a failure', () => {
      const reads = readsOf(withCondition, dslReading(7), modelReading([]));
      expect(reads.problems).toEqual([
        { kind: 'failed', message: 'listVariables of test for R1@1 failed: 7 is not a list' },
      ]);
      expect(reads.declared).toBe(false);
    });

    it('names the model when the model is the one that fails', () => {
      const reads = readsOf(withCondition, dslReading([]), modelReading(['rate'], 'Fiscal'));
      expect(reads.problems).toEqual([
        {
          kind: 'non-pointer',
          message: 'listVariables of Fiscal for R1@1 returned a non-pointer: rate',
        },
      ]);
    });

    it('a "-" segment names nothing to read: an invalid path, not a fact', () => {
      const reads = readsOf(withCondition, dslReading(['/enfants/-', '/ok']), modelReading([]));
      expect(reads.pointers).toEqual(['/ok']);
      expect(reads.problems).toEqual([
        {
          kind: 'invalid-path',
          message:
            "listVariables of test for R1@1 returned an invalid path: /enfants/- ('-' is not an index)",
        },
      ]);
      expect(reads.declared).toBe(false);
    });
  });

  describe('pointers are kept as they are (D-1)', () => {
    it('does not normalize indexes or Unicode: two spellings of é are two facts', () => {
      const precomposed = '/é';
      const combining = '/é';
      const reads = readsOf(
        withCondition,
        dslReading([precomposed, combining, '/enfants/01/age', '/enfants/1/age']),
        modelReading([]),
      );
      expect(reads.pointers).toEqual([precomposed, combining, '/enfants/01/age', '/enfants/1/age']);
      expect(reads.problems).toEqual([]);
    });

    it('does not split an output name at a colon', () => {
      expect(
        readsOf(withCondition, dslReading(['/$outputs/a:b/c']), modelReading([])).outputs,
      ).toEqual(['a:b']);
    });

    it('reads an escaped name as the output it names', () => {
      expect(
        readsOf(withCondition, dslReading(['/$outputs/a~1b/c']), modelReading([])).outputs,
      ).toEqual(['a/b']);
    });
  });
});
