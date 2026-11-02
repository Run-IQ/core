export { PPEEngine } from './engine/PPEEngine.js';
export type { PPEEngineConfig } from './engine/PPEEngine.js';
export type { Rule, Expression } from './types/rule.js';
export type { EvaluationInput, FactEncoder } from './types/input.js';
export type {
  EvaluationResult,
  UnsealedResult,
  BreakdownItem,
  SkippedRule,
  SkipReason,
} from './types/result.js';
export type { OutputValue, DecisionOutput } from './types/output.js';
export type { Diagnostic } from './types/diagnostic.js';
export type { DecisionStore } from './types/store.js';
export type { OutputType, CombineStrategy, OutputDeclaration, DecisionProof } from '@run-iq/spec';
export type { PPEPlugin, PluginContext, BeforeEvaluateResult } from './types/plugin.js';
export type {
  CalculationModel,
  CalculationOutput,
  ValidationResult,
  ParamDescriptor,
} from './types/model.js';
export type {
  DSLEvaluator,
  DSLCapabilities,
  DSLSyntaxDoc,
  DSLOperatorDoc,
  DSLExampleDoc,
} from './types/dsl.js';
export type { EvaluateOptions, RuleSetRef } from './types/options.js';
export type { ISnapshotAdapter, Snapshot } from './types/snapshot.js';
export type { EvaluationTrace, TraceStep } from './types/trace.js';
export {
  PPEError,
  RuleConflictError,
  ExceptionPrecedenceError,
  OutputNotFiniteError,
  DecimalPrecisionError,
  InvalidModelError,
  ModelNotFoundError,
  DSLNotFoundError,
  SnapshotFailureError,
  DSLTimeoutError,
  DSLEvaluationError,
  PipelineTimeoutError,
  HookTimeoutError,
  UnexpectedEngineError,
  ValidationError,
  DuplicateRequestError,
  EngineLimitError,
  PluginHookError,
  FrozenViewWriteError,
} from './errors/index.js';
export { ModelRegistry } from './registry/ModelRegistry.js';
export { DSLRegistry } from './registry/DSLRegistry.js';
export { hydrateRule, hydrateRules } from './utils/hydrate.js';
export { canonicalStringify } from './utils/json.js';
export { hashParams, computeRuleChecksum } from './utils/crypto.js';
export { VERSION } from './utils/version.js';
export { DEFAULT_LIMITS, resolveLimits } from './limits.js';
export type { EngineLimits, EngineLimitsInput } from './limits.js';
export { normalizeMeta, evaluationDate } from './input/normalizeMeta.js';
export type { NormalizedMeta } from './input/normalizeMeta.js';
export type { InputSeedConfig } from './input/inputSeed.js';
export { readsOf, MAX_LISTED_POINTERS } from './context/reads.js';
export type { Reads, ReadsProblem } from './context/reads.js';
export { buildContext } from './context/buildContext.js';
export type { ContextBase, ContextInstance } from './context/buildContext.js';
// Plugins import only `core` or `plugin-sdk`: the pointer functions of spec come through here.
export { formatPointer, parsePointer } from '@run-iq/spec';
export type { JsonPointer } from '@run-iq/spec';
