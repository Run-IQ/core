import Decimal from 'decimal.js';
import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { BreakdownItem } from '../types/result.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { TraceBuilder } from './TraceBuilder.js';

export interface PipelineResult {
  readonly value: number;
  readonly breakdown: readonly BreakdownItem[];
  readonly appliedRules: readonly Rule[];
}

export class ExecutionPipeline {
  constructor(private readonly modelRegistry: ModelRegistry) {}

  execute(
    rules: ReadonlyArray<Rule>,
    input: EvaluationInput,
    traceBuilder: TraceBuilder,
  ): PipelineResult {
    const breakdown: BreakdownItem[] = [];
    const appliedRules: Rule[] = [];
    let totalValue = new Decimal(0);

    for (const rule of rules) {
      const model = this.modelRegistry.get(rule.model);
      const stepStart = performance.now();

      const contribution = model.calculate(input.data, rule, rule.params);

      const durationMs = Math.round((performance.now() - stepStart) * 100) / 100;

      traceBuilder.addStep({
        ruleId: rule.id,
        conditionResult: true,
        conditionDetail: rule.condition?.value ?? null,
        modelUsed: model.name,
        inputSnapshot: { ...input.data },
        contribution,
        durationMs,
        dslUsed: rule.condition?.dsl,
      });

      breakdown.push({
        ruleId: rule.id,
        contribution,
        modelUsed: model.name,
      });

      appliedRules.push(rule);
      totalValue = totalValue.plus(new Decimal(String(contribution)));
    }

    return { value: totalValue.toNumber(), breakdown, appliedRules };
  }
}
