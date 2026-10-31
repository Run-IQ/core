import type { JsonValue } from '@run-iq/spec';
import type { EvaluationInput } from './input.js';
import type { EvaluationResult, SkippedRule } from './result.js';
import type { Rule } from './rule.js';
import type { CalculationModel } from './model.js';
import type { OutputValue } from './output.js';
import type { PPEError } from '../errors/PPEError.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { DSLRegistry } from '../registry/DSLRegistry.js';

export interface PluginContext {
  readonly modelRegistry: ModelRegistry;
  readonly dslRegistry: DSLRegistry;
  readonly engineVersion: string;
}

export interface BeforeEvaluateResult {
  readonly input: EvaluationInput;
  readonly rules: ReadonlyArray<Rule>;
  readonly skipped?: ReadonlyArray<SkippedRule>;
  /**
   * The plugin's own state for this evaluation, kept in `EvaluationResult.pluginState[name]` and
   * visible to `afterEvaluate`.
   */
  readonly state?: JsonValue | undefined;
}

export interface PPEPlugin {
  readonly name: string;
  readonly version: string;

  onInit(context: PluginContext): void;

  /**
   * Runs before the rules are filtered, in registration order; each plugin gets the input and
   * rules the previous one returned.
   *
   * - A `state` that is JSON is kept, as a copy, in `result.pluginState[name]`. Any other
   *   `state` is dropped with a diagnostic naming the first non-JSON path (`$.a[1] (Date)`); the
   *   returned input and rules are still used.
   * - If it throws (or exceeds `timeout.hook`: `HookTimeoutError`), its error becomes a diagnostic
   *   `{ source: 'hook', plugin, hook: 'beforeEvaluate', message }`, `onError` is called, and the
   *   evaluation goes on with the input and rules it had.
   */
  beforeEvaluate?(
    input: EvaluationInput,
    rules: ReadonlyArray<Rule>,
  ): BeforeEvaluateResult | Promise<BeforeEvaluateResult>;

  /**
   * Runs after the decision is computed, in registration order, on a copy of the result: writing
   * to it in place never reaches the engine's records or the caller's rules. The result it
   * returns replaces the decision, except that:
   *
   * - `requestId`, `engineVersion`, `outputs`, `diagnostics` and `pluginState` stay the engine's;
   *   a direct change of `outputs` is ignored with the diagnostic
   *   `plugin <name> changed outputs directly; ignored (rewrite value instead)`;
   * - rewriting `value` is the only way to change an output: it must be a finite number;
   *   `outputs.value.value` is set to it and a diagnostic says
   *   `plugin <name> rewrote output value from <old> to <new>`. Any other `value` makes the
   *   engine ignore the whole result, with a diagnostic;
   * - rules added to or removed from `appliedRules` or `skippedRules` are named in diagnostics.
   *
   * If it throws (or exceeds `timeout.hook`: `HookTimeoutError`), its error becomes a diagnostic with
   * `hook: 'afterEvaluate'`, `onError` is called, and the previous result is kept.
   */
  afterEvaluate?(
    input: EvaluationInput,
    result: EvaluationResult,
  ): EvaluationResult | Promise<EvaluationResult>;

  /**
   * Told of errors, never asked to recover from them. `error` is the thrown value when it is a
   * `PPEError`; any other thrown value (a model's `RangeError`, a hook's `TypeError`...) arrives
   * wrapped in `UnexpectedEngineError`, whose `cause` is the value as thrown. The caller of
   * `evaluate` always receives the original value.
   *
   * - A hook of this plugin threw: called with that error and the input the hook received,
   *   after the error's diagnostic. If `onError` throws, a second diagnostic says
   *   `onError failed: <message>`; the evaluation goes on either way.
   * - The evaluation itself failed (invalid input, `ModelNotFoundError`, `OutputNotFiniteError`,
   *   conflicts...): called on every plugin, in registration order, with that error and the input
   *   given to `evaluate`. `afterEvaluate` is not called and nothing is saved. If `onError`
   *   throws, its failure is dropped: the evaluation's own error always reaches the caller.
   * - Not called for `PipelineTimeoutError`, which `evaluate` raises while the pipeline may
   *   still be running; a pipeline that fails after that delay still calls `onError`.
   */
  onError?(error: PPEError, input: EvaluationInput): void;

  /** Models of any output type; those without a type argument compute numbers. */
  getModels?(): readonly CalculationModel<OutputValue>[];

  teardown?(): void;
}
