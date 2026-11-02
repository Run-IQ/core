import type { JsonValue } from '@run-iq/spec';
import type { EvaluationInput } from './input.js';
import type { UnsealedResult, SkippedRule } from './result.js';
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
   * rules the previous one returned. **Fail closed**: whatever goes wrong, the evaluation fails
   * with a `PluginHookError` (`plugin`, `hook`, `cause`), `onError` is called on every plugin, and
   * nothing is saved. A decision is never returned without the preparation a plugin was to do.
   *
   * - The returned value is read once (`input`, `rules`, `skipped` and `state` by name, own,
   *   non-enumerable or inherited), then copied and bounded: a list's `length` is read once, at
   *   most `limits.maxRules` rules, each rule, skip and the state bounded by `maxInputLeaves`
   *   (a rule by a fixed 100000 leaves) and `maxInputDepth`, without recursion. These are
   *   failures: a hook that throws or exceeds `timeout.hook` (`HookTimeoutError` is the `cause`);
   *   a result that is not an object; an `input` that is not an object; `rules` that are not a
   *   list of objects; `skipped` that is neither absent nor a list of exactly
   *   `{ rule, reason, detail? }` with a plugin reason (`PLUGIN`, or one of the deprecated
   *   `INHIBITED_BY_META_RULE`, `COUNTRY_MISMATCH`, `MODEL_NOT_FOUND`: never a reason of the
   *   engine's own stages); a `state` that is not JSON (`a state that is not JSON at $.a[1]
   *   (Date)`); a getter that throws. A skip without `detail` gets `skipped by plugin <name>`.
   * - The hook is handed views, never the objects the engine holds: a fresh frozen input (with
   *   its own copies of the dates in `meta`), and a fresh frozen list of fresh frozen copies of
   *   the rules. A write into a view throws in strict mode and has no effect otherwise; a `Date`
   *   it moves is its own copy. The engine never reads back anything it handed out: the hook
   *   returns new objects to change anything.
   * - The returned `input` is checked as the caller's is: the bounds (`maxInputDepth`,
   *   `maxInputLeaves`), `validateProofInput` on its canonical form (D-3, D-5, portable JSON,
   *   unknown `meta` keys), and in strict mode the evaluation date. Changing the data is allowed
   *   once it passes; changing `requestId` or `meta.tenantId` is not (the idempotence check and
   *   the record rest on them). At most `limits.maxRules` rules may be returned.
   * - The rules it returns are checked against a ledger the engine keeps, one entry per rule
   *   instance given. A rule dropped without a skip, returned more often than it was given
   *   (checked per `id@version` and checksum, so two contents under one name cannot be swapped),
   *   or whose content differs, fails. A skip names a given rule (same content), once, and that
   *   rule is not also returned. An `id@version` that already took part in the evaluation, given,
   *   skipped or refused at the source, cannot be added again with other content.
   * - A rule returned under the `id@version` of a given rule must be that rule: its checksum is
   *   the given one and it is the checksum of its content. A rule rewritten under the same name
   *   fails the evaluation. A rule it adds goes through the validation of a source rule (its
   *   checksum, then the params its model accepts), once; a refusal fails. An added rule that passes is evaluated and named in a diagnostic,
   *   `plugin <name> added rules: <id@version, ...>`.
   * - A `state` that is JSON is kept, as a copy, in `result.pluginState[name]`.
   */
  beforeEvaluate?(
    input: EvaluationInput,
    rules: ReadonlyArray<Rule>,
  ): BeforeEvaluateResult | Promise<BeforeEvaluateResult>;

  /**
   * Runs after the decision is computed, in registration order, on a copy of the result: writing
   * to it in place never reaches the engine's records or the caller's rules. **Fail closed**: it
   * cannot change the decision. The result it returns is read once (every field by name, own,
   * non-enumerable or inherited, then a deep copy), and:
   *
   * - it may set `meta` (an object of JSON: annotations on the result; it may add keys, and changing or
   *   removing a key another plugin set fails) and its own entry of `pluginState`
   *   (`pluginState[<name>]`, JSON);
   * - any change to `value`, `outputs`, `appliedRules`, `skippedRules`, `breakdown`, `trace` or
   *   any other field of the result (a field it adds, one it drops), and any change to another
   *   plugin's `pluginState` entry, fails the evaluation: `plugin <name> afterEvaluate changed
   *   the decision: <fields>`;
   * - a value that is not an object, a `meta` that is not an object, or a `pluginState` entry that
   *   is not JSON, fails the evaluation too;
   * - a hook that throws or exceeds `timeout.hook` fails it.
   *
   * Every failure is a `PluginHookError` (`hook: 'afterEvaluate'`); `onError` is called on every
   * plugin and nothing is saved.
   */
  afterEvaluate?(
    input: EvaluationInput,
    result: UnsealedResult,
  ): UnsealedResult | Promise<UnsealedResult>;

  /**
   * Told of errors, never asked to recover from them. `error` is the thrown value when it is a
   * `PPEError`; any other thrown value (a model's `RangeError`, a hook's `TypeError`...) arrives
   * wrapped in `UnexpectedEngineError`, whose `cause` is the value as thrown. The caller of
   * `evaluate` always receives the original value.
   *
   * - The evaluation failed (a hook failure, which is a `PluginHookError`; invalid input,
   *   `ModelNotFoundError`, `OutputNotFiniteError`, conflicts...): called on every plugin, in
   *   registration order, with that error and the input given to `evaluate`. No later hook runs
   *   and nothing is saved. If `onError`
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
