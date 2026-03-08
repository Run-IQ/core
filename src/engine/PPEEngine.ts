import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { EvaluationResult, SkippedRule } from '../types/result.js';
import type { PPEPlugin, PluginContext } from '../types/plugin.js';
import type { DSLEvaluator } from '../types/dsl.js';
import type { ISnapshotAdapter } from '../types/snapshot.js';
import type { PPEError } from '../errors/PPEError.js';
import { ModelRegistry } from '../registry/ModelRegistry.js';
import { PluginRegistry } from '../registry/PluginRegistry.js';
import { DSLRegistry } from '../registry/DSLRegistry.js';
import { InputSanitizer } from '../security/InputSanitizer.js';
import { RuleFilter } from './RuleFilter.js';
import { RuleValidator } from '../security/RuleValidator.js';
import { DominanceResolver } from './DominanceResolver.js';
import { ExecutionPipeline } from './ExecutionPipeline.js';
import { TraceBuilder } from './TraceBuilder.js';
import { PluginSandbox } from '../security/PluginSandbox.js';
import { SnapshotManager } from '../snapshot/SnapshotManager.js';
import { SnapshotSerializer } from '../snapshot/SnapshotSerializer.js';
import { VERSION } from '../utils/version.js';

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
}

const ENGINE_VERSION = VERSION;

export class PPEEngine {
  private readonly modelRegistry: ModelRegistry;
  private readonly pluginRegistry: PluginRegistry;
  private readonly dslRegistry: DSLRegistry;
  private readonly ruleFilter: RuleFilter;
  private readonly ruleValidator: RuleValidator;
  private readonly dominanceResolver: DominanceResolver;
  private readonly executionPipeline: ExecutionPipeline;
  private readonly sandbox: PluginSandbox;
  private readonly snapshotManager: SnapshotManager;
  private readonly plugins: readonly PPEPlugin[];
  private readonly strict: boolean;
  private readonly conflictMode: 'throw' | 'first';
  private readonly dryRun: boolean;

  constructor(config: PPEEngineConfig) {
    this.strict = config.strict ?? true;
    this.conflictMode = config.onConflict ?? (this.strict ? 'throw' : 'first');
    this.dryRun = config.dryRun ?? false;

    this.modelRegistry = new ModelRegistry();
    this.pluginRegistry = new PluginRegistry();
    this.dslRegistry = new DSLRegistry();

    this.sandbox = new PluginSandbox(config.timeout?.hook ?? 500, config.timeout?.dsl ?? 100);

    this.ruleFilter = new RuleFilter(this.dslRegistry, this.sandbox);
    this.ruleValidator = new RuleValidator(this.modelRegistry, config.onChecksumMismatch ?? 'skip');
    this.dominanceResolver = new DominanceResolver();
    this.executionPipeline = new ExecutionPipeline(this.modelRegistry);

    this.snapshotManager = new SnapshotManager(
      this.dryRun ? null : (config.snapshot ?? null),
      this.strict,
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

  async evaluate(rules: ReadonlyArray<Rule>, input: EvaluationInput): Promise<EvaluationResult> {
    const traceBuilder = new TraceBuilder();
    const allSkipped: SkippedRule[] = [];

    // Step 1: Input validation
    InputSanitizer.validate(input);

    // Step 2: Idempotence check
    const alreadyExists = await this.snapshotManager.exists(input.requestId);
    if (alreadyExists) {
      // Return a minimal result indicating cached
      return this.buildCachedResult(input);
    }

    // Step 3: Plugin beforeEvaluate hooks
    let currentInput = input;
    let currentRules: ReadonlyArray<Rule> = rules;
    for (const plugin of this.plugins) {
      if (plugin.beforeEvaluate) {
        try {
          const hookResult = await this.sandbox.runHook(
            () => plugin.beforeEvaluate!(currentInput, currentRules),
            plugin.name,
          );
          currentInput = hookResult.input;
          currentRules = hookResult.rules;
          
          // Collect rules explicitly skipped by the plugin
          if (hookResult.skipped) {
            allSkipped.push(...hookResult.skipped);
          }
        } catch (error) {
          if (plugin.onError) {
            plugin.onError(error as PPEError, currentInput);
          }
        }
      }
    }

    // Step 4: Rule filtering
    const now = currentInput.meta.effectiveDate ?? new Date();
    const filterResult = await this.ruleFilter.filter(currentRules, currentInput, now);
    allSkipped.push(...filterResult.skipped);

    // Step 5: Rule validation (checksum + params)
    const validationResult = this.ruleValidator.validate(filterResult.passed);
    allSkipped.push(...validationResult.invalid);

    // Step 6: Dominance resolution
    const resolvedRules = this.dominanceResolver.resolve(validationResult.valid, this.conflictMode);
    
    // Identify rules skipped due to conflict
    const resolvedIds = new Set(resolvedRules.map(r => r.id));
    for (const rule of validationResult.valid) {
      if (!resolvedIds.has(rule.id)) {
        allSkipped.push({ rule, reason: 'RULE_CONFLICT' });
      }
    }

    // Step 7: Execution pipeline
    const pipelineResult = this.executionPipeline.execute(
      resolvedRules,
      currentInput,
      traceBuilder,
    );

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
    let result: EvaluationResult = {
      requestId: input.requestId,
      value: pipelineResult.value,
      breakdown: pipelineResult.breakdown,
      appliedRules: pipelineResult.appliedRules,
      skippedRules: allSkipped,
      trace,
      snapshotId: '',
      engineVersion: ENGINE_VERSION,
      pluginVersions,
      dslVersions,
      timestamp: now,
    };

    // Step 8: Plugin afterEvaluate hooks
    for (const plugin of this.plugins) {
      if (plugin.afterEvaluate) {
        try {
          result = await this.sandbox.runHook(
            () => plugin.afterEvaluate!(currentInput, result),
            plugin.name,
          );
        } catch (error) {
          if (plugin.onError) {
            plugin.onError(error as PPEError, currentInput);
          }
        }
      }
    }

    // Step 9: Snapshot
    const snapshot = SnapshotSerializer.serialize(
      currentInput,
      rules,
      result,
      trace,
      ENGINE_VERSION,
      pluginVersions,
      dslVersions,
    );

    const snapshotId = await this.snapshotManager.save(snapshot);

    // Step 10: Return with snapshotId
    return { ...result, snapshotId };
  }

  private buildCachedResult(input: EvaluationInput): EvaluationResult {
    return {
      requestId: input.requestId,
      value: 0,
      breakdown: [],
      appliedRules: [],
      skippedRules: [],
      trace: { steps: [], totalDurationMs: 0 },
      snapshotId: 'cached',
      engineVersion: ENGINE_VERSION,
      pluginVersions: {},
      dslVersions: {},
      timestamp: new Date(),
    };
  }
}
