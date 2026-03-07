export { PPEEngine } from './engine/PPEEngine.js';
export type { PPEEngineConfig } from './engine/PPEEngine.js';
export type { Rule, Expression } from './types/rule.js';
export type { EvaluationInput } from './types/input.js';
export type { EvaluationResult, BreakdownItem, SkippedRule, SkipReason } from './types/result.js';
export type { PPEPlugin, PluginContext } from './types/plugin.js';
export type { CalculationModel, CalculationOutput, ValidationResult } from './types/model.js';
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
  ValidationError,
} from './errors/index.js';
export { hydrateRule, hydrateRules } from './utils/hydrate.js';
