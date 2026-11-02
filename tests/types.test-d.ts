import { describe, expectTypeOf, it } from 'vitest';
import { EVALUATE_OPTION_NAMES } from '../src/types/options.js';
import { formatPointer as specFormatPointer, parsePointer as specParsePointer } from '@run-iq/spec';
import {
  DEFAULT_LIMITS,
  buildContext,
  formatPointer,
  normalizeMeta,
  parsePointer,
  readsOf,
} from '../src/index.js';
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
  DSLCapabilities,
  DSLEvaluator,
  EngineLimitError,
  EngineLimitsInput,
  EngineLimits,
  EvaluateOptions,
  EvaluationInput,
  InputSeedConfig,
  JsonPointer,
  NormalizedMeta,
  PPEEngine,
  PPEEngineConfig,
  Reads,
  RuleSetRef,
  EvaluationResult,
  FactEncoder,
  ModelRegistry,
  OutputDeclaration,
  OutputType,
  OutputValue,
  PPEPlugin,
  PluginContext,
  Rule,
  SkippedRule,
  SkipReason,
  TraceStep,
  UnsealedResult,
  ValidationResult,
} from '../src/index.js';
import type { UnsettledException } from '../src/engine/ExceptionProcessor.js';
import type {
  ProofException as SpecProofException,
  CombineStrategy as SpecCombineStrategy,
  DecisionProof as SpecDecisionProof,
  FactAssertion,
  JsonPointer as SpecJsonPointer,
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

  it('registers models of any output type, directly and through the plugin context', () => {
    type Registered = Parameters<ModelRegistry['register']>[0];
    expectTypeOf(obligations).toMatchTypeOf<Registered>();
    expectTypeOf<LegacyNumberModel>().toMatchTypeOf<Registered>();
    expectTypeOf(obligations).toMatchTypeOf<
      Parameters<PluginContext['modelRegistry']['register']>[0]
    >();
    expectTypeOf<ReturnType<ModelRegistry['get']>>().toEqualTypeOf<CalculationModel<OutputValue>>();
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
  it('names the output, rule version and source of each breakdown item and trace step', () => {
    expectTypeOf<BreakdownItem['output']>().toEqualTypeOf<string>();
    expectTypeOf<BreakdownItem['ruleVersion']>().toEqualTypeOf<number>();
    expectTypeOf<BreakdownItem['sourceRef']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TraceStep['output']>().toEqualTypeOf<string>();
    expectTypeOf<TraceStep['ruleVersion']>().toEqualTypeOf<number>();
    expectTypeOf<TraceStep['sourceRef']>().toEqualTypeOf<string | undefined>();
  });

  it('accepts dimensions, dates and assertions in the input meta', () => {
    expectTypeOf<EvaluationInput['meta']['dimensions']>().toEqualTypeOf<
      Readonly<Record<string, string | readonly string[]>> | undefined
    >();
    expectTypeOf<EvaluationInput['meta']['dates']>().toEqualTypeOf<
      Readonly<Record<string, string | Date>> | undefined
    >();
    expectTypeOf<EvaluationInput['meta']['assertions']>().toEqualTypeOf<
      Readonly<Record<string, FactAssertion>> | undefined
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

describe('the transitional aliases are exactly the Omit of spec and result types', () => {
  it('UnsealedResult is EvaluationResult without proof and fromStore (Task 10 deletes it)', () => {
    expectTypeOf<UnsealedResult>().toEqualTypeOf<Omit<EvaluationResult, 'proof' | 'fromStore'>>();
    expectTypeOf<UnsealedResult>().not.toHaveProperty('proof');
    expectTypeOf<UnsealedResult>().not.toHaveProperty('fromStore');
    expectTypeOf<UnsealedResult['outputs']>().toEqualTypeOf<EvaluationResult['outputs']>();
  });

  it('UnsettledException is ProofException without status, stratum and salt (9M2, Task 10)', () => {
    expectTypeOf<UnsettledException>().toEqualTypeOf<
      Omit<SpecProofException, 'status' | 'stratum' | 'salt'>
    >();
    expectTypeOf<UnsettledException>().not.toHaveProperty('status');
    expectTypeOf<UnsettledException>().not.toHaveProperty('stratum');
    expectTypeOf<UnsettledException>().not.toHaveProperty('salt');
    expectTypeOf<UnsettledException['affected']>().toEqualTypeOf<SpecProofException['affected']>();
  });
});

describe('what 9L adds to the public surface', () => {
  it('re-exports the pointer functions and type of spec: plugins import only core', () => {
    expectTypeOf(formatPointer).toEqualTypeOf<typeof specFormatPointer>();
    expectTypeOf(parsePointer).toEqualTypeOf<typeof specParsePointer>();
    expectTypeOf<JsonPointer>().toEqualTypeOf<SpecJsonPointer>();
  });

  it('exports the limits, the reads, the context and the options', () => {
    expectTypeOf<keyof EngineLimits>().toEqualTypeOf<
      | 'maxRules'
      | 'maxInstances'
      | 'maxCollectionLength'
      | 'maxInputLeaves'
      | 'maxInputDepth'
      | 'maxStrata'
      | 'maxSegments'
      | 'maxRecursionDepth'
      | 'maxReferentialNodes'
      | 'maxGroupDepth'
      | 'maxRuleLeaves'
      | 'maxHookLeaves'
    >();
    expectTypeOf(DEFAULT_LIMITS).toEqualTypeOf<Readonly<EngineLimits>>();
    // @ts-expect-error DEFAULT_LIMITS is frozen: it is read-only for the compiler too
    DEFAULT_LIMITS.maxRules = 5;
    expectTypeOf<EngineLimitError['limit']>().toEqualTypeOf<keyof EngineLimits>();
    expectTypeOf(readsOf).parameters.toEqualTypeOf<
      [Rule, DSLEvaluator | undefined, CalculationModel<OutputValue> | undefined]
    >();
    expectTypeOf(readsOf).returns.toEqualTypeOf<Reads>();
    expectTypeOf(normalizeMeta).returns.toEqualTypeOf<NormalizedMeta>();
    expectTypeOf(buildContext).returns.toEqualTypeOf<Readonly<Record<string, unknown>>>();
    expectTypeOf<EvaluateOptions>().toHaveProperty('requested');
    // The list of names covers every option: a field added to EvaluateOptions and forgotten in
    // the list fails here, not at run time.
    expectTypeOf<(typeof EVALUATE_OPTION_NAMES)[number]>().toEqualTypeOf<keyof EvaluateOptions>();
    expectTypeOf<RuleSetRef>().toMatchTypeOf<{ kind: 'pack' | 'local' }>();
  });

  it('types the reads of a DSL and of a model as pointers, and adds compute and capabilities', () => {
    expectTypeOf<DSLEvaluator['listVariables']>().toEqualTypeOf<
      ((expression: unknown) => JsonPointer[]) | undefined
    >();
    expectTypeOf<CalculationModel['listVariables']>().toEqualTypeOf<
      ((params: unknown) => JsonPointer[]) | undefined
    >();
    expectTypeOf<DSLEvaluator['compute']>().toEqualTypeOf<
      ((expression: unknown, context: Record<string, unknown>) => JsonValue) | undefined
    >();
    expectTypeOf<DSLEvaluator['capabilities']>().toEqualTypeOf<DSLCapabilities | undefined>();
  });

  it('lets evaluate take options, and the engine take limits and an input seed', () => {
    expectTypeOf<Parameters<PPEEngine['evaluate']>>().toEqualTypeOf<
      [rules: ReadonlyArray<Rule>, input: EvaluationInput, options?: EvaluateOptions]
    >();
    expectTypeOf<PPEEngineConfig['limits']>().toEqualTypeOf<EngineLimitsInput | undefined>();
    expectTypeOf<PPEEngineConfig['inputSeed']>().toEqualTypeOf<InputSeedConfig | undefined>();
  });
});
