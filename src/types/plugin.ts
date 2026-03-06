import type { EvaluationInput } from './input.js';
import type { EvaluationResult } from './result.js';
import type { Rule } from './rule.js';
import type { PPEError } from '../errors/PPEError.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { DSLRegistry } from '../registry/DSLRegistry.js';

export interface PluginContext {
  readonly modelRegistry: ModelRegistry;
  readonly dslRegistry: DSLRegistry;
  readonly engineVersion: string;
}

export interface PPEPlugin {
  readonly name: string;
  readonly version: string;

  onInit(context: PluginContext): void;

  beforeEvaluate?(input: EvaluationInput, rules: ReadonlyArray<Rule>): EvaluationInput;

  afterEvaluate?(input: EvaluationInput, result: EvaluationResult): EvaluationResult;

  onError?(error: PPEError, input: EvaluationInput): void;

  teardown?(): void;
}
