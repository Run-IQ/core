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
   * - The returned value is read once (`input`, `rules`, `skipped` and `state` by name, own,
   *   non-enumerable or inherited, then a deep copy) and checked
   *   as a whole: `input` an object with object `data` and `meta`, `rules` an array of objects,
   *   `skipped` absent or an array of `{ rule: object, reason: string, detail?: string }`. A
   *   result that fails a check, or a getter that throws, is a hook error (below): nothing of it
   *   is used. A skip without `detail` gets `skipped by plugin <name>`.
   * - Rules dropped from `rules` without being listed in `skipped` are named in a diagnostic,
   *   `plugin <name> removed rules without a skip: <id@version, ...>`, and rules it adds in
   *   `plugin <name> added rules: <id@version, ...>` (multisets: duplicates count).
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
   * returns is read once (each field it may change by name, own, non-enumerable or inherited,
   * then a deep copy) and replaces the decision,
   * except that:
   *
   * - only `value`, `appliedRules`, `skippedRules`, `trace`, `breakdown` and `meta` may change.
   *   The other fields are the engine's (`requestId`, `engineVersion`, `outputs`, `diagnostics`,
   *   `missingFacts`, `pluginState`, `pluginVersions`, `dslVersions`, `timestamp`, `proof`,
   *   `fromStore`, and any added field): changes to them are ignored and named in one diagnostic,
   *   `plugin <name> changed engine-owned fields <a, b>; ignored`, which ends with
   *   ` (rewrite value instead)` when `outputs` is among them;
   * - rewriting `value` is the only way to change an output: it must be a finite number;
   *   `outputs.value.value` is set to it and a diagnostic says
   *   `plugin <name> rewrote output value from <old> to <new>`. Any other `value` makes the
   *   engine ignore the whole result, with a diagnostic;
   * - rules added to, removed from, or changed in `appliedRules` or `skippedRules` (same id,
   *   different entry) are named in diagnostics;
   * - a returned value that is not an object, or with malformed lists, `trace` (its `steps`
   *   must be an array of objects) or `meta`, is a
   *   hook error (`plugin <name> afterEvaluate returned 42, not a result; ignored`).
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
   * - Not called for `PipelineTimeoutError`, nor for anything that happens after it: the
   *   pipeline still running is aborted at its next step (no further hook, no save, no
   *   `onError`).
   */
  onError?(error: PPEError, input: EvaluationInput): void;

  /** Models of any output type; those without a type argument compute numbers. */
  getModels?(): readonly CalculationModel<OutputValue>[];

  teardown?(): void;
}
