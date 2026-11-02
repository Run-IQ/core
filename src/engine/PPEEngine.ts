import { canonicalize } from '@run-iq/spec';
import type { JsonValue } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { SkippedRule, UnsealedResult } from '../types/result.js';
import type { PPEPlugin, PluginContext } from '../types/plugin.js';
import type { DSLEvaluator } from '../types/dsl.js';
import type { ISnapshotAdapter } from '../types/snapshot.js';
import type { Diagnostic } from '../types/diagnostic.js';
import { ValidationError } from '../errors/ValidationError.js';
import { DuplicateRequestError } from '../errors/DuplicateRequestError.js';
import { PipelineTimeoutError } from '../errors/PipelineTimeoutError.js';
import { UnexpectedEngineError } from '../errors/UnexpectedEngineError.js';
import { PluginHookError } from '../errors/PluginHookError.js';
import { ModelRegistry } from '../registry/ModelRegistry.js';
import { PluginRegistry } from '../registry/PluginRegistry.js';
import { DSLRegistry } from '../registry/DSLRegistry.js';
import { InputSanitizer } from '../security/InputSanitizer.js';
import type { PreparedInput } from '../security/InputSanitizer.js';
import { EngineLimitError } from '../errors/EngineLimitError.js';
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
import { describeThrown, ruleLabel } from '../utils/values.js';
import { acceptAfterEvaluate } from './afterEvaluateTransition.js';
import { readBeforeEvaluate } from './beforeEvaluateResult.js';
import { Budget, RuleLedger, readItems } from './pluginBoundary.js';
import { trapped } from './frozenView.js';
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
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ValidationError('Invalid evaluate options', ['evaluate options must be an object']);
  }
  const reasons: string[] = [];
  for (const name of Object.keys(options)) {
    if (!(EVALUATE_OPTION_NAMES as readonly string[]).includes(name))
      reasons.push(`unknown evaluate option: ${name}`);
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
  private readonly plugins: readonly PPEPlugin[];
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

    // Initialize plugins
    this.plugins = config.plugins;
    const context: PluginContext = {
      modelRegistry: this.modelRegistry,
      dslRegistry: this.dslRegistry,
      engineVersion: ENGINE_VERSION,
    };

    for (const plugin of this.plugins) {
      this.pluginRegistry.register(plugin);
      plugin.onInit(context);
    }
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
    try {
      return await this.runPipeline(rules, input, options, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // What the plugins are told is not writable: one plugin cannot rewrite the attribution (the
      // `plugin`, the `message`) of a failure that the caller then receives.
      const told = Object.freeze(UnexpectedEngineError.wrap(error));
      for (const plugin of this.plugins) {
        if (!plugin.onError) continue;
        try {
          plugin.onError(told, input);
        } catch {
          // Contract of PPEPlugin.onError: the evaluation's own error reaches the caller.
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
  private copySourceRules(rules: ReadonlyArray<Rule>): Rule[] {
    try {
      // justification: each item is a copy of a rule; the validator checks it as one.
      return readItems(
        rules,
        this.limits,
        'rules',
        new Budget('maxHookLeaves', this.limits.maxHookLeaves),
      ) as Rule[];
    } catch (error) {
      if (error instanceof EngineLimitError) throw error;
      throw new ValidationError('Invalid rules', [describeThrown(error)]);
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
  ): Promise<UnsealedResult> {
    // The options and the number of rules come first: no hook runs, nothing is read, for a call
    // that is refused whatever the input.
    checkEvaluateOptions(options);
    const ruleCount = countRules(rules);
    if (ruleCount > this.limits.maxRules) {
      throw new EngineLimitError('maxRules', this.limits.maxRules, ruleCount);
    }

    const traceBuilder = new TraceBuilder();
    const allSkipped: SkippedRule[] = [];

    // Step 1: Input validation. One plain copy of the input is made and checked; the hooks, the
    // rules and the models all work on it, never on the caller's object (D-5).
    const prepared = this.acceptInput(input);
    // The request id read once, by `prepare`: the seed, the duplicate check, the result and the
    // record all use this one, never the caller's object again.
    const requestId = prepared.input.requestId;
    const tenantId = prepared.input.meta.tenantId;
    checkDerivedSeed(this.inputSeed, requestId);

    // Step 2: Idempotence check
    const alreadyExists = await this.snapshotManager.exists(requestId);
    if (alreadyExists) throw new DuplicateRequestError(requestId);

    // The registries are fixed for this evaluation: a model or a DSL registered or replaced while
    // it runs is not seen, so that what the rules are validated against is what runs.
    const models = this.modelRegistry.snapshot();
    const dsls = this.dslRegistry.snapshot();
    const ruleValidator = new RuleValidator(models, this.onChecksumMismatch);
    const ruleFilter = new RuleFilter(dsls, this.sandbox);
    const exceptionProcessor = new ExceptionProcessor(models);
    const executionPipeline = new ExecutionPipeline(models, this.conflictMode);

    // Step 3: Rule validation (checksum of the source rules). The engine works on its own frozen
    // copies of the rules: the caller's objects are never handed to a hook, so a hook cannot
    // rewrite a rule in place, and a caller cannot change one while hooks are awaited.
    const sourceCopies = this.copySourceRules(rules);
    const initialValidation = ruleValidator.validate(sourceCopies);
    allSkipped.push(...initialValidation.invalid);

    // The ledger of the given rules: held by the engine alone, from here on. Hooks get views of
    // it and what they return is checked against it; a label refused here cannot come back.
    const ledger = new RuleLedger(initialValidation.valid, sourceCopies.map(ruleLabel));
    let currentRules: ReadonlyArray<Rule> = ledger.current();

    // Step 4: Plugin beforeEvaluate hooks. Their diagnostics follow the engine's own ones.
    const hookDiagnostics: Diagnostic[] = [];
    const pluginState: Record<string, JsonValue> = {};
    let currentInput = prepared.input;
    let currentMeta = prepared.meta;
    let currentDate = prepared.evaluationDate;
    for (const plugin of this.plugins) {
      const hook = plugin.beforeEvaluate;
      if (!hook) continue;
      signal.throwIfAborted();
      let reading: BeforeEvaluateReading;
      let accepted: PreparedInput;
      let outcome: LedgerOutcome;
      // All the leaves one return makes the engine read count against one bound.
      const budget = new Budget('maxHookLeaves', this.limits.maxHookLeaves);
      try {
        // Read once and checked as a whole: nothing is committed unless every check passes.
        reading = readBeforeEvaluate(
          plugin.name,
          await this.sandbox.runHook(
            () => hook.call(plugin, hookView(currentInput), ledger.view()),
            plugin.name,
            'beforeEvaluate',
            signal,
          ),
          this.limits,
          budget,
        );
        // The input a hook returns is checked as the caller's was (bounds, spec, strict mode),
        // and it is the same request: the idempotence check and the record rest on these two.
        accepted = this.acceptInput(reading.input);
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
        if (!sameCanonical(currentMeta, accepted.meta)) {
          throw new Error(`plugin ${plugin.name} changed meta, which only the caller declares`);
        }
        outcome = ledger.apply(plugin.name, reading, ruleValidator);
      } catch (error) {
        // Fail closed: a decision computed without what a plugin was to prepare is not returned.
        signal.throwIfAborted();
        throw new PluginHookError(plugin.name, 'beforeEvaluate', error);
      }
      signal.throwIfAborted();
      currentInput = accepted.input;
      currentMeta = accepted.meta;
      currentDate = accepted.evaluationDate;
      currentRules = outcome.rules;
      allSkipped.push(...outcome.skipped);
      if (reading.state !== undefined) pluginState[plugin.name] = reading.state;
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

    const dslVersions: Record<string, string> = {};
    for (const [name, evaluator] of dsls.getAll()) {
      dslVersions[name] = evaluator.version;
    }

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
        const handed = trapped(before);
        const returned = await this.sandbox.runHook(
          () => hook.call(plugin, hookView(currentInput), handed),
          plugin.name,
          'afterEvaluate',
          signal,
        );
        signal.throwIfAborted();
        result = acceptAfterEvaluate(plugin.name, before, handed, returned, this.limits).result;
      } catch (error) {
        signal.throwIfAborted();
        throw new PluginHookError(plugin.name, 'afterEvaluate', error);
      }
    }

    // Step 10: Snapshot — use the rules that actually executed (post-plugin)
    const snapshot = SnapshotSerializer.serialize(
      currentInput,
      currentRules,
      result,
      trace,
      ENGINE_VERSION,
      pluginVersions,
      dslVersions,
    );

    signal.throwIfAborted();
    await this.snapshotManager.save(snapshot);

    // Step 11: Return the result; spec dropped `snapshotId`, the proof replaces it
    return result;
  }
}

type HookName = 'beforeEvaluate' | 'afterEvaluate';

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
    throw new ValidationError('Invalid rules', [`rules could not be read: ${describeThrown(error)}`]);
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

function hookDiagnostic(plugin: PPEPlugin, hook: HookName, message: string): Diagnostic {
  return { source: 'hook', plugin: plugin.name, hook, message };
}
