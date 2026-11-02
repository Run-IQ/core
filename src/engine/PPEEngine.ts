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
import { copyData, ruleLabel } from '../utils/values.js';
import { acceptAfterEvaluate } from './afterEvaluateTransition.js';
import { readBeforeEvaluate } from './beforeEvaluateResult.js';
import { checkHookRules } from './hookRules.js';
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
  private readonly ruleFilter: RuleFilter;
  private readonly ruleValidator: RuleValidator;
  private readonly exceptionProcessor: ExceptionProcessor;
  private readonly dominanceResolver: DominanceResolver;
  private readonly executionPipeline: ExecutionPipeline;
  private readonly sandbox: PluginSandbox;
  private readonly snapshotManager: SnapshotManager;
  private readonly plugins: readonly PPEPlugin[];
  private readonly strict: boolean;
  private readonly conflictMode: 'throw' | 'first';
  private readonly dryRun: boolean;
  private readonly pipelineTimeout: number | undefined;
  private readonly limits: EngineLimits;
  private readonly inputSeed: InputSeedConfig | undefined;

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

    this.ruleFilter = new RuleFilter(this.dslRegistry, this.sandbox);
    this.ruleValidator = new RuleValidator(this.modelRegistry, config.onChecksumMismatch ?? 'skip');
    this.exceptionProcessor = new ExceptionProcessor(this.modelRegistry);
    this.dominanceResolver = new DominanceResolver();
    this.executionPipeline = new ExecutionPipeline(this.modelRegistry, this.conflictMode);

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
      for (const plugin of this.plugins) {
        if (!plugin.onError) continue;
        try {
          plugin.onError(UnexpectedEngineError.wrap(error), input);
        } catch {
          // Contract of PPEPlugin.onError: the evaluation's own error reaches the caller.
        }
      }
      throw error;
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
    if (rules.length > this.limits.maxRules) {
      throw new EngineLimitError('maxRules', this.limits.maxRules, rules.length);
    }

    const traceBuilder = new TraceBuilder();
    const allSkipped: SkippedRule[] = [];

    // Step 1: Input validation. One plain copy of the input is made and checked; the hooks, the
    // rules and the models all work on it, never on the caller's object (D-5).
    const prepared = this.acceptInput(input);
    checkDerivedSeed(this.inputSeed, input.requestId);

    // Step 2: Idempotence check
    const alreadyExists = await this.snapshotManager.exists(input.requestId);
    if (alreadyExists) throw new DuplicateRequestError(input.requestId);

    // Step 3: Rule validation (checksum of the source rules)
    const initialValidation = this.ruleValidator.validate(rules);
    allSkipped.push(...initialValidation.invalid);

    // Continue with valid source rules
    let currentRules: ReadonlyArray<Rule> = initialValidation.valid;

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
      try {
        // Read once and checked as a whole: nothing is committed unless every check passes.
        reading = readBeforeEvaluate(
          plugin.name,
          await this.sandbox.runHook(
            () => hook.call(plugin, currentInput, currentRules),
            plugin.name,
            'beforeEvaluate',
            signal,
          ),
        );
        // The input a hook returns is checked as the caller's was (bounds, spec, strict mode).
        accepted = this.acceptInput(reading.input);
        // Rules dropped without a skip would be lost in silence: the engine does not accept it.
        const lost = ruleChanges(currentRules, reading).removed;
        if (lost.length > 0) {
          throw new Error(`plugin ${plugin.name} removed rules without a skip: ${lost.join(', ')}`);
        }
        // Rules rewritten under the same name, or added with a checksum that does not hold, would
        // be evaluated as if they were the source rules.
        checkHookRules(plugin.name, currentRules, reading.rules);
      } catch (error) {
        // Fail closed: a decision computed without what a plugin was to prepare is not returned.
        signal.throwIfAborted();
        throw new PluginHookError(plugin.name, 'beforeEvaluate', error);
      }
      signal.throwIfAborted();
      const { added } = ruleChanges(currentRules, reading);
      currentInput = accepted.input;
      currentMeta = accepted.meta;
      currentDate = accepted.evaluationDate;
      currentRules = reading.rules;
      allSkipped.push(...reading.skipped);
      if (reading.state !== undefined) pluginState[plugin.name] = reading.state;
      if (added.length > 0) {
        hookDiagnostics.push(
          hookDiagnostic(
            plugin,
            'beforeEvaluate',
            `plugin ${plugin.name} added rules: ${added.join(', ')}`,
          ),
        );
      }
    }

    // Step 5: Rule filtering (on potentially mutated rules)
    signal.throwIfAborted();
    const now = currentDate ?? new Date();
    const filterResult = await this.ruleFilter.filter(currentRules, currentInput, now, currentMeta);
    allSkipped.push(...filterResult.skipped);

    // Step 6: Native exceptions. The short-circuited values feed the output combination; the
    // exception records are for the proof (Task 10).
    const exceptionResult = this.exceptionProcessor.apply(filterResult.passed, this.conflictMode);
    allSkipped.push(...exceptionResult.skipped);

    // Step 7: Dominance resolution
    const { kept: resolvedRules, skipped: dominanceSkipped } = this.dominanceResolver.resolve(
      exceptionResult.rules,
      this.conflictMode,
    );
    allSkipped.push(...dominanceSkipped);

    // Step 8: Execution and combination, output by output
    const pipelineResult = this.executionPipeline.execute(
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
    for (const [name, evaluator] of this.dslRegistry.getAll()) {
      dslVersions[name] = evaluator.version;
    }

    // Build initial result
    let result: UnsealedResult = {
      requestId: input.requestId,
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
      const handed = copyData(before);
      try {
        const returned = await this.sandbox.runHook(
          () => hook.call(plugin, currentInput, handed),
          plugin.name,
          'afterEvaluate',
          signal,
        );
        signal.throwIfAborted();
        result = acceptAfterEvaluate(plugin.name, before, returned).result;
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
 * What a `beforeEvaluate` did to the rules it was given, as `id@version` labels sorted by
 * `compareRuleIdentity`, matched as multisets (a dropped or added duplicate is named):
 * - `removed`: given rules neither in the returned `rules` nor in `skipped`;
 * - `added`: returned rules not among the given ones.
 * The plugin's copies, possibly rewritten, count as the same rule when their label is the same.
 */
function ruleChanges(
  given: ReadonlyArray<Rule>,
  reading: BeforeEvaluateReading,
): { removed: string[]; added: string[] } {
  return {
    removed: unmatched(given, [...reading.rules, ...reading.skipped.map((skip) => skip.rule)]),
    added: unmatched(reading.rules, given),
  };
}

/** The rules of `from` left once each rule of `take` cancels one of the same label. */
function unmatched(from: ReadonlyArray<Rule>, take: ReadonlyArray<Rule>): string[] {
  const left = new Map<string, number>();
  for (const rule of take) left.set(ruleLabel(rule), (left.get(ruleLabel(rule)) ?? 0) + 1);
  const rest: Rule[] = [];
  for (const rule of from) {
    const count = left.get(ruleLabel(rule)) ?? 0;
    if (count > 0) left.set(ruleLabel(rule), count - 1);
    else rest.push(rule);
  }
  return rest.sort(compareRuleIdentity).map(ruleLabel);
}

function hookDiagnostic(plugin: PPEPlugin, hook: HookName, message: string): Diagnostic {
  return { source: 'hook', plugin: plugin.name, hook, message };
}
