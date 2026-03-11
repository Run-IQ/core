export { PPEEngine } from './engine/PPEEngine.js';
export type { PPEEngineConfig } from './engine/PPEEngine.js';
export type { Rule, Expression } from './types/rule.js';
export type { EvaluationInput } from './types/input.js';
export type { EvaluationResult, BreakdownItem, SkippedRule, SkipReason } from './types/result.js';
export type { PPEPlugin, PluginContext, BeforeEvaluateResult } from './types/plugin.js';
export type { CalculationModel, CalculationOutput, ValidationResult, ParamDescriptor } from './types/model.js';
export type { DSLEvaluator } from './types/dsl.js';
export type { ISnapshotAdapter, Snapshot } from './types/snapshot.js';
export type { EvaluationTrace, TraceStep } from './types/trace.js';
export {
  PPEError,
  RuleConflictError,
  ModelNotFoundError,
  DSLNotFoundError,
  SnapshotFailureError,
  DSLTimeoutError,
  DSLEvaluationError,
  PipelineTimeoutError,
  ValidationError,
} from './errors/index.js';
export { ModelRegistry } from './registry/ModelRegistry.js';
export { DSLRegistry } from './registry/DSLRegistry.js';
export { hydrateRule, hydrateRules } from './utils/hydrate.js';
export { canonicalStringify } from './utils/json.js';
export { hashParams, computeRuleChecksum } from './utils/crypto.js';
