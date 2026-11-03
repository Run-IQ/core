import type { JsonValue } from '@run-iq/spec';
import type { EvaluationInput } from './input.js';
import type { UnsealedResult, SkippedRule } from './result.js';
import type { Rule } from './rule.js';
import type { CalculationModel } from './model.js';
import type { OutputValue } from './output.js';
import type { PPEError } from '../errors/PPEError.js';
import type { DSLEvaluator } from './dsl.js';

/** What a plugin can do with the models: register, look up and list. Nothing else of the engine. */
export interface ModelRegistryApi {
  register(model: CalculationModel<OutputValue>): void;
  get(name: string): CalculationModel<OutputValue>;
  has(name: string): boolean;
  /** A copy: writing to it changes nothing. */
  getAll(): ReadonlyMap<string, CalculationModel<OutputValue>>;
}

/** What a plugin can do with the DSL evaluators: register, look up and list. */
export interface DslRegistryApi {
  register(evaluator: DSLEvaluator): void;
  get(dsl: string): DSLEvaluator | undefined;
  has(dsl: string): boolean;
  /** A copy: writing to it changes nothing. */
  getAll(): ReadonlyMap<string, DSLEvaluator>;
}

export interface PluginContext {
  readonly modelRegistry: ModelRegistryApi;
  readonly dslRegistry: DslRegistryApi;
  readonly engineVersion: string;
}

/** What `afterEvaluate` returns: annotations on the result, under the plugin's name in `meta`. */
export interface AfterEvaluateResult {
  readonly annotations?: Readonly<Record<string, JsonValue>> | undefined;
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

  /**
   * Called once, when the engine is built. Synchronous: a promise it returns is a breach, never
   * awaited, and a throw or a promise makes the construction fail with a `PluginHookError`
   * (`hook: 'onInit'`). The `name` and `version` of a plugin, a model and a DSL are read once, when
   * they are registered, and checked: a name is 1 to 128 characters of letters, digits and
   * `. _ - @ /`, a version is semver of at most 64 characters.
   */
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
   *   (Date)`); a getter that throws. The engine records every skip with `detail` `plugin <name>: <your words>` (`plugin <name>: skipped` when you give none): the record always says which plugin skipped.
   * - The hook is handed frozen data: a frozen input (with its own copies of the dates in
   *   `meta`) and a fresh frozen list of the engine's rules. The rules are deep-frozen and hold no
   *   `Date`: their bounds, `params`, `condition.value` and extension fields are strings (a `Date`
   *   in a rule is written as `YYYY-MM-DDTHH:MM:SS.sssZ` when the engine reads it), so they are
   *   handed as they are. A write throws in strict mode and has no effect otherwise. The engine
   *   never reads back anything it handed out: the hook returns new objects to change anything.
   * - The returned `input` is checked as the caller's is: the bounds (`maxInputDepth`,
   *   `maxInputLeaves`), `validateProofInput` on its canonical form (D-3, D-5, portable JSON,
   *   unknown `meta` keys), and in strict mode the evaluation date. Changing the data is allowed
   *   once it passes. Changing `meta` at all is not (the date, the named dates, the dimensions,
   *   the tags, the context and the assertions are the caller's declarations; the engine never
   *   guesses), nor `requestId` (the idempotence check and the record rest on it). The total of
   *   the leaves one return makes the engine read (rules, skips, state and data) is held to
   *   `limits.maxHookLeaves`. At most `limits.maxRules` rules may be returned.
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
   * Runs after the decision is computed, in registration order, on a view of the result that
   * refuses every write (a `FrozenViewWriteError`, which fails the hook): nothing it does to the
   * view reaches the engine's records or the caller's rules. **It returns annotations, not a
   * result**: nothing, or `{ annotations?: <JSON object> }`, and nothing else. The annotations are
   * read once through the reader (copied, bounded, their text weighed against the one budget of
   * the evaluation and counted in the record room) and merged into `result.meta` under the
   * plugin's name; the result is not copied. **Fail closed**: it cannot change the decision,
   * because it cannot return anything that would. A field other than `annotations`, a return that
   * is not nothing or a plain object, annotations that are not a JSON object, a hook that throws,
   * rejects or exceeds `timeout.hook` fails the evaluation.
   *
   * Every failure is a `PluginHookError` (`hook: 'afterEvaluate'`); `onError` is called on every
   * plugin and nothing is saved.
   */
  afterEvaluate?(
    input: EvaluationInput,
    result: Readonly<UnsealedResult>,
  ): AfterEvaluateResult | void | Promise<AfterEvaluateResult | void>;

  /**
   * Told of errors, never asked to recover from them. It is synchronous: a promise it returns is
   * a breach, never awaited, its rejection handled. `error` is a deep-frozen copy of the
   * evaluation's failure, which the engine built; what a plugin threw is in it as text
   * (`name`, `message`, `code`), never as the object the plugin holds. `input` is the engine's
   * own frozen copy of the input, never the caller's object (a frozen empty input when the failure
   * came before the input was read). The caller of `evaluate` receives the failure itself.
   *
   * - The evaluation failed (a hook failure, which is a `PluginHookError`; invalid input,
   *   `ModelNotFoundError`, `OutputNotFiniteError`, conflicts...): called on every plugin, in
   *   registration order. No later hook runs and nothing is saved. If `onError`
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
