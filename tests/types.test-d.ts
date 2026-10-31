import { describe, expectTypeOf, it } from 'vitest';
import type {
  BeforeEvaluateResult,
  BreakdownItem,
  CalculationModel,
  CalculationOutput,
  CombineStrategy,
  DecisionOutput,
  DecisionProof,
  DecisionStore,
  Diagnostic,
  DSLEvaluator,
  EvaluationInput,
  EvaluationResult,
  FactEncoder,
  OutputDeclaration,
  OutputType,
  OutputValue,
  PPEPlugin,
  Rule,
  SkippedRule,
  SkipReason,
  TraceStep,
  ValidationResult,
} from '../src/index.js';
import type {
  CombineStrategy as SpecCombineStrategy,
  DecisionProof as SpecDecisionProof,
  JsonValue,
  OutputDeclaration as SpecOutputDeclaration,
  OutputType as SpecOutputType,
} from '@run-iq/spec';

/** A model written before phase 2: it returns a bare number, with no output declaration. */
class LegacyNumberModel implements CalculationModel {
  readonly name = 'FLAT';
  readonly version = '1.0.0';

  validateParams(_params: unknown): ValidationResult {
    return { valid: true };
  }

  calculate(_input: Record<string, unknown>, _rule: Readonly<Rule>, _params: unknown): number {
    return 1;
  }
}

/** A model written before phase 2 that returns `number | CalculationOutput`, like `BaseModel`. */
class LegacyDetailModel implements CalculationModel {
  readonly name = 'PROGRESSIVE';
  readonly version = '1.0.0';

  validateParams(_params: unknown): ValidationResult {
    return { valid: true };
  }

  calculate(
    _input: Record<string, unknown>,
    _rule: Readonly<Rule>,
    _params: unknown,
  ): number | CalculationOutput {
    return { value: 1, detail: { brackets: [] } };
  }
}

const obligations: CalculationModel<string[]> = {
  name: 'OBLIGATION',
  version: '1.0.0',
  output: { type: 'list', combine: 'union' },
  validateParams: () => ({ valid: true }),
  calculate: () => ({ value: ['register'], detail: 'listed' }),
};

describe('CalculationModel (outputs)', () => {
  it('keeps a pre-phase-2 model assignable without a type argument', () => {
    expectTypeOf<LegacyNumberModel>().toMatchTypeOf<CalculationModel>();
    expectTypeOf<LegacyDetailModel>().toMatchTypeOf<CalculationModel>();
    expectTypeOf<CalculationModel>().toEqualTypeOf<CalculationModel<number>>();
    expectTypeOf<CalculationOutput>().toEqualTypeOf<CalculationOutput<number>>();
  });

  it('accepts a typed model that declares its output', () => {
    expectTypeOf<CalculationModel<string[]>['output']>().toEqualTypeOf<
      OutputDeclaration | undefined
    >();
    expectTypeOf<ReturnType<CalculationModel<string[]>['calculate']>>().toEqualTypeOf<
      string[] | CalculationOutput<string[]>
    >();
  });

  it('refuses a value that is not JSON', () => {
    // @ts-expect-error a Date is not a JsonValue
    expectTypeOf<CalculationModel<Date>>().not.toBeNever();
  });

  it('lets a plugin provide models of any output type', () => {
    type Provided = ReturnType<NonNullable<PPEPlugin['getModels']>>[number];
    expectTypeOf<LegacyNumberModel>().toMatchTypeOf<Provided>();
    expectTypeOf(obligations).toMatchTypeOf<Provided>();
  });
});

describe('re-exports from spec', () => {
  it('exposes the output and proof types of spec', () => {
    expectTypeOf<OutputValue>().toEqualTypeOf<JsonValue>();
    expectTypeOf<OutputType>().toEqualTypeOf<SpecOutputType>();
    expectTypeOf<CombineStrategy>().toEqualTypeOf<SpecCombineStrategy>();
    expectTypeOf<OutputDeclaration>().toEqualTypeOf<SpecOutputDeclaration>();
    expectTypeOf<DecisionProof>().toEqualTypeOf<SpecDecisionProof>();
  });
});

describe('EvaluationResult (decision)', () => {
  it('has no snapshotId anymore', () => {
    // @ts-expect-error snapshotId is replaced by the proof and the decision store
    expectTypeOf<EvaluationResult['snapshotId']>().toBeString();
    expectTypeOf<EvaluationResult>().not.toHaveProperty('snapshotId');
  });

  it('carries outputs, diagnostics, missing facts, plugin state, proof and origin', () => {
    expectTypeOf<EvaluationResult['outputs']>().toEqualTypeOf<
      Readonly<Record<string, DecisionOutput>>
    >();
    expectTypeOf<EvaluationResult['diagnostics']>().toEqualTypeOf<readonly Diagnostic[]>();
    expectTypeOf<EvaluationResult['missingFacts']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<EvaluationResult['pluginState']>().toEqualTypeOf<
      Readonly<Record<string, JsonValue>>
    >();
    expectTypeOf<EvaluationResult['proof']>().toEqualTypeOf<DecisionProof>();
    expectTypeOf<EvaluationResult['fromStore']>().toEqualTypeOf<boolean>();
  });

  it('describes an output', () => {
    expectTypeOf<DecisionOutput>().toEqualTypeOf<{
      readonly name: string;
      readonly type: OutputType;
      readonly combine: CombineStrategy;
      readonly value: JsonValue;
      readonly contributors: readonly string[];
    }>();
  });

  it('describes a diagnostic', () => {
    expectTypeOf<Diagnostic['source']>().toEqualTypeOf<'hook' | 'engine'>();
    expectTypeOf<Diagnostic['plugin']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Diagnostic['hook']>().toEqualTypeOf<
      'beforeEvaluate' | 'afterEvaluate' | undefined
    >();
    expectTypeOf<Diagnostic['message']>().toEqualTypeOf<string>();
  });
});

describe('SkipReason and SkippedRule', () => {
  it('accepts the phase 2 reasons', () => {
    expectTypeOf<'DOMINATED'>().toMatchTypeOf<SkipReason>();
    expectTypeOf<'INHIBITED'>().toMatchTypeOf<SkipReason>();
    expectTypeOf<'DIMENSION_MISMATCH'>().toMatchTypeOf<SkipReason>();
    expectTypeOf<'OUTPUT_MISMATCH'>().toMatchTypeOf<SkipReason>();
    expectTypeOf<'SHORT_CIRCUITED'>().toMatchTypeOf<SkipReason>();
  });

  it('keeps the plugin reasons until plugin-fiscal migrates', () => {
    expectTypeOf<'COUNTRY_MISMATCH'>().toMatchTypeOf<SkipReason>();
    expectTypeOf<'INHIBITED_BY_META_RULE'>().toMatchTypeOf<SkipReason>();
  });

  it('keeps detail optional for plugins', () => {
    expectTypeOf<SkippedRule['detail']>().toEqualTypeOf<string | undefined>();
  });
});

describe('breakdown, trace, input and hooks', () => {
  it('names the output of each breakdown item and trace step', () => {
    expectTypeOf<BreakdownItem['output']>().toEqualTypeOf<string>();
    expectTypeOf<TraceStep['output']>().toEqualTypeOf<string>();
    expectTypeOf<TraceStep['ruleVersion']>().toEqualTypeOf<number>();
    expectTypeOf<TraceStep['sourceRef']>().toEqualTypeOf<string | undefined>();
  });

  it('accepts dimensions in the input meta', () => {
    expectTypeOf<EvaluationInput['meta']['dimensions']>().toEqualTypeOf<
      Readonly<Record<string, string>> | undefined
    >();
  });

  it('lets beforeEvaluate return a JSON state', () => {
    expectTypeOf<BeforeEvaluateResult['state']>().toEqualTypeOf<JsonValue | undefined>();
  });

  it('lets a DSL list the variables of an expression', () => {
    expectTypeOf<DSLEvaluator['listVariables']>().toEqualTypeOf<
      ((expression: unknown) => string[]) | undefined
    >();
  });
});

describe('DecisionStore and FactEncoder', () => {
  it('stores and finds decisions by requestId', () => {
    expectTypeOf<DecisionStore['save']>().toEqualTypeOf<
      (decision: EvaluationResult) => Promise<void>
    >();
    expectTypeOf<DecisionStore['findByRequestId']>().toEqualTypeOf<
      (requestId: string) => Promise<EvaluationResult | null>
    >();
  });

  it('encodes a fact with the shared signature', () => {
    expectTypeOf<FactEncoder['name']>().toEqualTypeOf<string>();
    expectTypeOf<FactEncoder['test']>().toEqualTypeOf<(value: unknown) => boolean>();
    expectTypeOf<FactEncoder['encode']>().toEqualTypeOf<(value: unknown) => JsonValue>();
  });
});
