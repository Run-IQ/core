import { canonicalize } from '@run-iq/spec';
import type { JsonValue } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { SkippedRule, UnsealedResult } from '../types/result.js';
import type {
  BeforeEvaluateResult,
  DslRegistryApi,
  ModelRegistryApi,
  PPEPlugin,
  PluginContext,
} from '../types/plugin.js';
import type { DSLEvaluator } from '../types/dsl.js';
import type { ISnapshotAdapter } from '../types/snapshot.js';
import type { Diagnostic } from '../types/diagnostic.js';
import { ValidationError } from '../errors/ValidationError.js';
import { clip } from '../utils/frozenCopy.js';
import { DuplicateRequestError } from '../errors/DuplicateRequestError.js';
import { PipelineTimeoutError } from '../errors/PipelineTimeoutError.js';
import { UnexpectedEngineError } from '../errors/UnexpectedEngineError.js';
import { PluginHookError } from '../errors/PluginHookError.js';
import type { PPEError } from '../errors/PPEError.js';
import { ModelRegistry, snapshotModels } from '../registry/ModelRegistry.js';
import { PluginRegistry } from '../registry/PluginRegistry.js';
import { DSLRegistry, snapshotDsls } from '../registry/DSLRegistry.js';
import { InputSanitizer } from '../security/InputSanitizer.js';
import type { PreparedInput } from '../security/InputSanitizer.js';
import { isRaisedLimit, raiseLimit } from '../errors/EngineLimitError.js';
import { checkDerivedSeed, readInputSeedConfig } from '../input/inputSeed.js';
import type { InputSeedConfig } from '../input/inputSeed.js';
import { resolveLimits } from '../limits.js';
import type { EngineLimits, EngineLimitsInput } from '../limits.js';
import { EVALUATE_OPTION_NAMES } from '../types/options.js';
import type { EvaluateOptions } from '../types/options.js';
import { RuleFilter } from './RuleFilter.js';
import { RuleValidator } from '../security/RuleValidator.js';
import { DominanceResolver } from './DominanceResolver.js';
import { ExceptionProcessor } from './ExceptionProcessor.js';
import { ExecutionPipeline } from './ExecutionPipeline.js';
import { compareRuleIdentity } from './resolveTie.js';
import { TraceBuilder } from './TraceBuilder.js';
import { PluginSandbox } from '../security/PluginSandbox.js';
import { SnapshotManager } from '../snapshot/SnapshotManager.js';
import { SnapshotSerializer } from '../snapshot/SnapshotSerializer.js';
import { VERSION } from '../utils/version.js';
import { frozenErrorCopy } from '../utils/frozenCopy.js';
import { describeThrown, ruleLabel } from '../utils/values.js';
import { acceptAfterEvaluate } from './afterEvaluateTransition.js';
import { readBeforeEvaluate } from './beforeEvaluateResult.js';
import { Budget, RuleLedger, charsOfRule, readItems } from './pluginBoundary.js';
import { callAsync, callSync, reading } from './pluginPort.js';
import { isolate } from './trust.js';
import type { PluginHandle } from '../registry/PluginRegistry.js';
import type { Crossing } from './pluginBoundary.js';
import { ViewScope } from './frozenView.js';
import type { LedgerOutcome } from './pluginBoundary.js';
import type { BeforeEvaluateReading } from './beforeEvaluateResult.js';

export interface PPEEngineConfig {
  readonly plugins: PPEPlugin[];
  readonly dsls: DSLEvaluator[];
  readonly snapshot?: ISnapshotAdapter | undefined;
  readonly strict?: boolean | undefined;
  readonly timeout?:
    | {
        readonly dsl?: number | undefined;
        readonly hook?: number | undefined;
        readonly pipeline?: number | undefined;
      }
    | undefined;
  readonly onConflict?: 'throw' | 'first' | undefined;
  readonly onChecksumMismatch?: 'throw' | 'skip' | undefined;
  readonly dryRun?: boolean | undefined;
  readonly onSnapshotError?: ((error: unknown) => void) | undefined;
  /**
   * The bounds of an evaluation, over `DEFAULT_LIMITS`. Refused at construction (`ValidationError`)
   * when a value is not a positive integer, a key is unknown, or `maxInputDepth` is above 1000.
   */
  readonly limits?: EngineLimitsInput | undefined;
  /**
   * Where the salt of the input digest comes from (Task 10 uses it): `{ secret }` of at least 32
   * bytes, or `{ derive(requestId) }` returning exactly 32. Checked in 9L: the secret at
   * construction, `derive` at each evaluation.
   */
  readonly inputSeed?: InputSeedConfig | undefined;
}

const ENGINE_VERSION = VERSION;

/**
 * Checks the names of the options of `evaluate`: an object (or none), whose members are among
 * `EVALUATE_OPTION_NAMES`, whatever the value (a misspelled name with an unset value is still a
 * misspelling). Their values are checked by
 * the tasks that wire them. Throws `ValidationError` (`Invalid evaluate options`).
 */
function checkEvaluateOptions(options: unknown): void {
  if (options === undefined) return;
  const reasons: string[] = [];
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError('Invalid evaluate options', ['evaluate options must be an object']);
    }
    for (const name of Object.keys(options)) {
      if (!(EVALUATE_OPTION_NAMES as readonly string[]).includes(name))
        reasons.push(`unknown evaluate option: ${name}`);
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    // A revoked Proxy, a trap that throws: named, not raw.
    throw new ValidationError('Invalid evaluate options', [
      `options could not be read: ${describeThrown(error)}`,
    ]);
  }
  if (reasons.length > 0) throw new ValidationError('Invalid evaluate options', reasons);
}

export class PPEEngine {
  private readonly modelRegistry: ModelRegistry;
  private readonly pluginRegistry: PluginRegistry;
  private readonly dslRegistry: DSLRegistry;
  private readonly dominanceResolver: DominanceResolver;
  private readonly sandbox: PluginSandbox;
  private readonly snapshotManager: SnapshotManager;
  private readonly plugins: readonly PluginHandle[];
  private readonly strict: boolean;
  private readonly conflictMode: 'throw' | 'first';
  private readonly dryRun: boolean;
  private readonly pipelineTimeout: number | undefined;
  private readonly limits: EngineLimits;
  private readonly inputSeed: InputSeedConfig | undefined;
  private readonly onChecksumMismatch: 'throw' | 'skip';

  constructor(config: PPEEngineConfig) {
    this.strict = config.strict ?? true;
    this.conflictMode = config.onConflict ?? (this.strict ? 'throw' : 'first');
    this.dryRun = config.dryRun ?? false;
    this.pipelineTimeout = config.timeout?.pipeline;
    this.limits = resolveLimits(config.limits);
    this.inputSeed = readInputSeedConfig(config.inputSeed);

    this.modelRegistry = new ModelRegistry();
    this.pluginRegistry = new PluginRegistry();
    this.dslRegistry = new DSLRegistry();

    this.sandbox = new PluginSandbox(config.timeout?.hook ?? 500, config.timeout?.dsl ?? 100);

    this.onChecksumMismatch = config.onChecksumMismatch ?? 'skip';
    this.dominanceResolver = new DominanceResolver();

    this.snapshotManager = new SnapshotManager(
      this.dryRun ? null : (config.snapshot ?? null),
      this.strict,
      config.onSnapshotError,
    );

    // Register DSL evaluators
    for (const dsl of config.dsls) {
      this.dslRegistry.register(dsl);
    }

    // Initialize plugins. Each is read once, when it is registered; from then on the engine uses
    // what it took (a name and a version it checked, the functions) and calls them through the port.
    // What a plugin is handed are two thin views of the registries, closures over the real ones:
    // they register, look up and list, and reach nothing else of the engine.
    const models = this.modelRegistry;
    const dsls = this.dslRegistry;
    const modelApi: ModelRegistryApi = {
      register: (model) => models.register(model),
      get: (name) => models.describe(name),
      has: (name) => models.has(name),
      getAll: () => models.describeAll(),
    };
    const dslApi: DslRegistryApi = {
      register: (evaluator) => dsls.register(evaluator),
      get: (dsl) => dsls.describe(dsl),
      has: (dsl) => dsls.has(dsl),
      getAll: () => dsls.describeAll(),
    };
    Object.freeze(modelApi);
    Object.freeze(dslApi);
    const context: PluginContext = Object.freeze({
      modelRegistry: modelApi,
      dslRegistry: dslApi,
      engineVersion: ENGINE_VERSION,
    });

    const handles: PluginHandle[] = [];
    {
      // A constructor called from inside a plugin's callback raises for no read in progress.
      const restore = isolate();
      try {
        for (const plugin of config.plugins) {
          const handle = this.pluginRegistry.register(plugin);
          handles.push(handle);
          try {
            // `onInit` is synchronous: a promise it returns is a fault, and its rejection is handled.
            callSync(handle.onInit, plugin, [context]);
          } catch (error) {
            // A throw of plugin code reaches the caller as the engine's own error, holding its text.
            throw new PluginHookError(handle.name, 'onInit', error);
          }
        }
      } finally {
        restore();
      }
    }
    this.plugins = handles;
  }

  /**
   * Evaluates `rules` against `input`.
   *
   * `result.diagnostics` lists, in this order: the engine's own diagnostics (rule filter), then
   * the `beforeEvaluate` diagnostics by plugin in registration order, then the `afterEvaluate`
   * ones by plugin in registration order (see `PPEPlugin` for what each hook reports).
   *
   * With `timeout.pipeline`, rejects with `PipelineTimeoutError` past that delay; its timer is
   * cleared whatever the outcome. The pipeline still running then is aborted: it stops at its
   * next step, before any further hook, before saving, and without calling `onError`.
   */
  async evaluate(
    rules: ReadonlyArray<Rule>,
    input: EvaluationInput,
    options?: EvaluateOptions,
  ): Promise<UnsealedResult> {
    const abort = new AbortController();
    const timeoutMs = this.pipelineTimeout;
    if (timeoutMs === undefined) return this.executeEvaluation(rules, input, options, abort.signal);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new PipelineTimeoutError(timeoutMs);
        abort.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.executeEvaluation(rules, input, options, abort.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs the pipeline; an error it throws goes to every plugin's `onError`, then to the caller,
   * unless the evaluation was aborted (its caller already has a `PipelineTimeoutError`).
   */
  private async executeEvaluation(
    rules: ReadonlyArray<Rule>,
    input: EvaluationInput,
    options: EvaluateOptions | undefined,
    signal: AbortSignal,
  ): Promise<UnsealedResult> {
    const seen: { input?: EvaluationInput } = {};
    try {
      // An evaluation started from inside a plugin's callback (a nested engine) raises its errors
      // for no read of the evaluation around it.
      const restore = isolate();
      let running: Promise<UnsealedResult>;
      try {
        running = this.runPipeline(rules, input, options, signal, seen);
      } finally {
        restore();
      }
      return await running;
    } catch (error) {
      if (signal.aborted) throw error;
      // What the plugins are told is not writable: one plugin cannot rewrite the attribution (the
      // `plugin`, the `message`) of a failure that the caller then receives. Nor is the input: it
      // is the engine's frozen copy, never the caller's object.
      const told = frozenErrorCopy(UnexpectedEngineError.wrap(error)) as PPEError;
      const shown = seen.input === undefined ? ABSENT_INPUT : hookView(seen.input);
      for (const plugin of this.plugins) {
        if (!plugin.onError) continue;
        try {
          // `onError` is synchronous: a promise it returns is a fault, and its rejection handled.
          callSync(plugin.onError, plugin.source, [told, shown]);
        } catch {
          // Contract of PPEPlugin.onError (B59): a failing `onError` is dropped, and the
          // evaluation's own error reaches the caller.
        }
      }
      throw error;
    }
  }

  /**
   * The engine's own copies of the source rules: the list read once (its length once, each item
   * once), each rule bounded on its own (`maxInputLeaves`, `maxInputDepth`), frozen, with its own
   * `Date`s. A rule that cannot be read is a `ValidationError`; the caller's objects are never
   * frozen, read again, or handed to a plugin.
   */
  private copySourceRules(rules: ReadonlyArray<Rule>, owned: WeakSet<object>): Rule[] {
    try {
      // justification: each item is a copy of a rule; the validator checks it as one.
      const copies = readItems(
        rules,
        this.limits,
        'rules',
        new Budget('maxRuleSetNodes', this.limits.maxRuleSetNodes),
        owned,
      ) as Rule[];
      // Two given rules with one `id@version` are refused, identical copies included: the engine
      // never guesses which of them is meant (B24).
      const slots = new Map<string, number>();
      copies.forEach((rule, slot) => {
        const { id, version } = rule as { id?: unknown; version?: unknown };
        if (typeof id !== 'string' || typeof version !== 'number') return;
        const label = `${id}@${version}`;
        const first = slots.get(label);
        if (first !== undefined) {
          throw new ValidationError('Invalid rules', [
            `rules/${first} and rules/${slot} are both ${clip(label)}`,
          ]);
        }
        slots.set(label, slot);
      });
      return copies;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      if (isRaisedLimit(error)) throw error;
      throw new ValidationError('Invalid rules', [describeThrown(error)]);
    }
  }

  /**
   * Refuses, by name, an evaluation whose record cannot fit: the text of its rules (once) and of its
   * input (once, and again in each step of the trace) is a lower bound of the record, known before
   * anything is cloned or serialized.
   */
  private assertRecordRoom(
    rules: ReadonlyArray<Rule>,
    inputChars: number,
    steps: number,
    pluginChars: number,
  ): void {
    let chars = inputChars * (1 + steps) + pluginChars;
    for (const rule of rules) chars += charsOfRule(rule);
    if (chars > this.limits.maxRecordLength) {
      throw raiseLimit('maxRecordLength', this.limits.maxRecordLength, chars);
    }
  }

  /**
   * Checks an input and makes its plain copy (`InputSanitizer.prepare`), then holds it to strict
   * mode: the evaluation date, as `meta.effectiveDate` or `meta.dates.effective`, must be given.
   * The caller's input and each input a `beforeEvaluate` hook returns go through here.
   */
  private acceptInput(input: unknown): PreparedInput {
    const prepared = InputSanitizer.prepare(input, this.limits);
    if (this.strict && prepared.evaluationDate === undefined) {
      throw new ValidationError('effectiveDate is required in strict mode', [
        'meta.effectiveDate or meta.dates.effective must be provided when strict mode is enabled',
      ]);
    }
    return prepared;
  }

  private async runPipeline(
    rules: ReadonlyArray<Rule>,
    input: EvaluationInput,
    options: EvaluateOptions | undefined,
    signal: AbortSignal,
    seen: { input?: EvaluationInput },
  ): Promise<UnsealedResult> {
    // The options and the number of rules come first: no hook runs, nothing is read, for a call
    // that is refused whatever the input.
    checkEvaluateOptions(options);
    const ruleCount = countRules(rules);
    if (ruleCount > this.limits.maxRules) {
      throw raiseLimit('maxRules', this.limits.maxRules, ruleCount);
    }

    const traceBuilder = new TraceBuilder();
    const allSkipped: SkippedRule[] = [];

    // Step 1: Input validation. One plain copy of the input is made and checked; the hooks, the
    // rules and the models all work on it, never on the caller's object (D-5).
    const prepared = this.acceptInput(input);
    // The request id read once, by `prepare`: the seed, the duplicate check, the result and the
    // record all use this one, never the caller's object again.
    seen.input = prepared.input;
    const requestId = prepared.input.requestId;
    const tenantId = prepared.input.meta.tenantId;
    checkDerivedSeed(this.inputSeed, requestId);

    // Step 2: Idempotence check
    const alreadyExists = await this.snapshotManager.exists(requestId);
    if (alreadyExists) throw new DuplicateRequestError(requestId);

    // The registries are fixed for this evaluation: a model or a DSL registered or replaced while
    // it runs is not seen, so that what the rules are validated against is what runs.
    const models = snapshotModels(this.modelRegistry);
    const dsls = snapshotDsls(this.dslRegistry);
    // Everything plugin code hands the engine in this evaluation (what the hooks return, what the
    // models and the DSLs answer, the text of their errors) is read through the one reader and
    // counted against this one budget: three hooks cannot read three times as much.
    const budget = new Budget('maxHookLeaves', this.limits.maxHookLeaves);
    const crossing: Crossing = { limits: this.limits, budget };
    const ruleValidator = new RuleValidator(models, this.onChecksumMismatch, crossing);
    const ruleFilter = new RuleFilter(dsls, this.sandbox, crossing);
    const exceptionProcessor = new ExceptionProcessor(models, crossing);
    const executionPipeline = new ExecutionPipeline(models, this.conflictMode, this.limits, budget);

    // Step 3: Rule validation (checksum of the source rules). The engine works on its own frozen
    // copies of the rules: the caller's objects are never handed to a hook, so a hook cannot
    // rewrite a rule in place, and a caller cannot change one while hooks are awaited.
    // The rules this evaluation owns: a set per evaluation, never shared with another evaluation
    // or another engine (an object from elsewhere is untrusted data, copied and counted).
    const owned: WeakSet<object> = new WeakSet();
    const sourceCopies = this.copySourceRules(rules, owned);
    // The text of the rules alone may already be more than the record can hold: refused before any
    // checksum is computed.
    this.assertRecordRoom(sourceCopies, prepared.chars, 0, 0);
    const initialValidation = ruleValidator.validate(sourceCopies);
    allSkipped.push(...initialValidation.invalid);

    // The ledger of the given rules: held by the engine alone, from here on. Hooks get views of
    // it and what they return is checked against it; a label refused here cannot come back.
    const ledger = new RuleLedger(initialValidation.valid, sourceCopies.map(ruleLabel), owned);
    let currentRules: ReadonlyArray<Rule> = ledger.current();

    // Step 4: Plugin beforeEvaluate hooks. Their diagnostics follow the engine's own ones.
    const hookDiagnostics: Diagnostic[] = [];
    const pluginState: Record<string, JsonValue> = {};
    let currentInput = prepared.input;
    let currentInputNodes = prepared.leaves;
    let currentInputChars = prepared.chars;
    let currentMeta = prepared.meta;
    let currentDate = prepared.evaluationDate;
    for (const plugin of this.plugins) {
      const hook = plugin.beforeEvaluate;
      if (!hook) continue;
      signal.throwIfAborted();
      let read: BeforeEvaluateReading;
      let accepted: PreparedInput;
      let outcome: LedgerOutcome;
      try {
        // The call is the port's; a throw, a rejection or a promise where none is allowed is a fault
        // of the plugin, held as text. What it returned is read once and checked as a whole:
        // nothing is committed unless every check passes.
        const returned = (
          await this.sandbox.runHook(
            () => callAsync(hook, plugin.source, [hookView(currentInput), ledger.view()]),
            plugin.name,
            'beforeEvaluate',
            signal,
          )
        ).value as BeforeEvaluateResult;
        read = readBeforeEvaluate(plugin.name, returned, this.limits, budget, owned);
        // The input a hook returns is checked as the caller's was (bounds, spec, strict mode),
        // and it is the same request: the idempotence check and the record rest on these two.
        const handed = read.input;
        accepted = reading(() => this.acceptInput(handed));
        budget.add(accepted.leaves);
        if (accepted.input.requestId !== requestId) {
          throw new Error(
            `plugin ${plugin.name} changed requestId from ${JSON.stringify(requestId)} to ${JSON.stringify(accepted.input.requestId)}`,
          );
        }
        if (accepted.input.meta.tenantId !== tenantId) {
          throw new Error(
            `plugin ${plugin.name} changed meta.tenantId from ${JSON.stringify(tenantId)} to ${JSON.stringify(accepted.input.meta.tenantId)}`,
          );
        }
        // The rules and the skips are the given ones, or verified new ones: nothing rewritten,
        // doubled, dropped or invented.
        // The meta is the caller's declaration (the date, the named dates, the dimensions, the
        // tags): a hook may change the data, not what the caller declared.
        // The exact shape: which keys are present, and their values (an absent `tags` and an empty
        // one are different declarations), then the canonical form that the rules read.
        if (
          !sameCanonical(currentInput.meta, accepted.input.meta) ||
          !sameCanonical(currentMeta, accepted.meta)
        ) {
          throw new Error(`plugin ${plugin.name} changed meta, which only the caller declares`);
        }
        outcome = ledger.apply(plugin.name, read, ruleValidator);
      } catch (error) {
        // Fail closed: a decision computed without what a plugin was to prepare is not returned.
        signal.throwIfAborted();
        throw new PluginHookError(plugin.name, 'beforeEvaluate', error);
      }
      signal.throwIfAborted();
      currentInput = accepted.input;
      currentInputNodes = accepted.leaves;
      currentInputChars = accepted.chars;
      currentMeta = accepted.meta;
      currentDate = accepted.evaluationDate;
      currentRules = outcome.rules;
      allSkipped.push(...outcome.skipped);
      if (read.state !== undefined) pluginState[plugin.name] = read.state;
      if (outcome.added.length > 0) {
        hookDiagnostics.push(
          hookDiagnostic(
            plugin,
            'beforeEvaluate',
            `plugin ${plugin.name} added rules: ${outcome.added.join(', ')}`,
          ),
        );
      }
    }

    // Step 5: Rule filtering (on potentially mutated rules)
    signal.throwIfAborted();
    const now = currentDate ?? new Date();
    const filterResult = await ruleFilter.filter(currentRules, currentInput, now, currentMeta);
    allSkipped.push(...filterResult.skipped);

    // Step 6: Native exceptions. The short-circuited values feed the output combination; the
    // exception records are for the proof (Task 10).
    const exceptionResult = exceptionProcessor.apply(filterResult.passed, this.conflictMode);
    allSkipped.push(...exceptionResult.skipped);

    // Step 7: Dominance resolution
    const { kept: resolvedRules, skipped: dominanceSkipped } = this.dominanceResolver.resolve(
      exceptionResult.rules,
      this.conflictMode,
    );
    allSkipped.push(...dominanceSkipped);

    // Step 8: Execution and combination, output by output
    const pipelineResult = executionPipeline.execute(
      resolvedRules,
      currentInput,
      traceBuilder,
      exceptionResult.shortCircuits,
      currentInputNodes,
    );
    allSkipped.push(...pipelineResult.skipped);
    // Every stage lists its own exclusions; the decision lists them by id@version, whatever the
    // order of the rules (the sort is stable: a rule's stages keep their order).
    const skippedRules = [...allSkipped].sort((a, b) => compareRuleIdentity(a.rule, b.rule));

    // Build trace
    const trace = traceBuilder.build();

    // Build plugin/dsl versions
    const pluginVersions: Record<string, string> = {};
    for (const plugin of this.plugins) {
      pluginVersions[plugin.name] = plugin.version;
    }

    const dslVersions = dsls.versions();

    // Build initial result
    let result: UnsealedResult = {
      requestId,
      value: pipelineResult.outputs.value.value,
      outputs: pipelineResult.outputs,
      breakdown: pipelineResult.breakdown,
      appliedRules: pipelineResult.applied,
      skippedRules,
      trace,
      diagnostics: [...filterResult.diagnostics, ...hookDiagnostics],
      missingFacts: filterResult.missingFacts,
      pluginState,
      engineVersion: ENGINE_VERSION,
      pluginVersions,
      dslVersions,
      timestamp: new Date(),
    };

    // Step 9: Plugin afterEvaluate hooks. Each one gets a copy, so that nothing it writes reaches
    // the engine's records; acceptAfterEvaluate says what the engine keeps of what it returns.
    for (const plugin of this.plugins) {
      const hook = plugin.afterEvaluate;
      if (!hook) continue;
      signal.throwIfAborted();
      const before = result;
      try {
        // A view that refuses every write, over the result as it is: nothing is copied, and a
        // field the hook returns unchanged is the very object of the view.
        const handed = new ViewScope().trapped(before);
        const returned = (
          await this.sandbox.runHook(
            () => callAsync(hook, plugin.source, [hookView(currentInput), handed]),
            plugin.name,
            'afterEvaluate',
            signal,
          )
        ).value;
        signal.throwIfAborted();
        // It returns annotations, not a result: they are read through the one budget of the
        // evaluation, like every other thing plugin code hands the engine, and merged under its
        // name. The result is not copied.
        result = acceptAfterEvaluate(plugin.name, before, returned, this.limits, budget).result;
      } catch (error) {
        signal.throwIfAborted();
        throw new PluginHookError(plugin.name, 'afterEvaluate', error);
      }
    }

    this.assertRecordRoom(currentRules, currentInputChars, trace.steps.length, budget.recordChars);

    // Step 10: Snapshot — use the rules that actually executed (post-plugin)
    const snapshot = SnapshotSerializer.serialize(
      currentInput,
      currentRules,
      result,
      trace,
      ENGINE_VERSION,
      pluginVersions,
      dslVersions,
      this.limits.maxRecordLength,
    );

    signal.throwIfAborted();
    await this.snapshotManager.save(snapshot);

    // Step 11: Return the result; spec dropped `snapshotId`, the proof replaces it
    return result;
  }
}

type HookName = 'beforeEvaluate' | 'afterEvaluate';

/** What `onError` is handed when the failure came before the input was copied. */
const ABSENT_INPUT: EvaluationInput = Object.freeze({
  requestId: '',
  data: Object.freeze({}),
  meta: Object.freeze({ tenantId: '' }),
});

/**
 * The input as a hook gets it: the engine's frozen data, and its own copies of the dates of
 * `meta` (a frozen `Date` can still be written with `setTime`).
 */
function hookView(input: EvaluationInput): EvaluationInput {
  const { effectiveDate, dates } = input.meta;
  const meta = {
    ...input.meta,
    ...(effectiveDate === undefined ? {} : { effectiveDate: new Date(effectiveDate.getTime()) }),
    ...(dates === undefined
      ? {}
      : {
          dates: Object.freeze(
            Object.fromEntries(
              Object.entries(dates).map(([name, date]) => [
                name,
                date instanceof Date ? new Date(date.getTime()) : date,
              ]),
            ),
          ),
        }),
  };
  return Object.freeze({ ...input, meta: Object.freeze(meta) });
}

/** The number of rules given, read once; an unreadable list is a `ValidationError`. */
function countRules(rules: unknown): number {
  try {
    if (Array.isArray(rules)) return rules.length;
  } catch (error) {
    throw new ValidationError('Invalid rules', [
      `rules could not be read: ${describeThrown(error)}`,
    ]);
  }
  // Not a list: `readItems` says so, as a `ValidationError`.
  return 0;
}

/** True when two canonical metas have the same canonical form (a value without one differs). */
function sameCanonical(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

function hookDiagnostic(plugin: PluginHandle, hook: HookName, message: string): Diagnostic {
  return { source: 'hook', plugin: plugin.name, hook, message };
}
