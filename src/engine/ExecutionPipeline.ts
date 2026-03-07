import Decimal from 'decimal.js';
import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { BreakdownItem } from '../types/result.js';
import type { CalculationOutput } from '../types/model.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { TraceBuilder } from './TraceBuilder.js';

export interface PipelineResult {
  readonly value: number;
  readonly breakdown: readonly BreakdownItem[];
  readonly appliedRules: readonly Rule[];
}

function normalizeOutput(raw: number | CalculationOutput): CalculationOutput {
  if (typeof raw === 'number') {
    return { value: raw };
  }
  return raw;
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

      const raw = model.calculate(input.data, rule, rule.params);
      const output = normalizeOutput(raw);

      const durationMs = Math.round((performance.now() - stepStart) * 100) / 100;

      traceBuilder.addStep({
        ruleId: rule.id,
        conditionResult: true,
        conditionDetail: rule.condition?.value ?? null,
        modelUsed: model.name,
        inputSnapshot: { ...input.data },
        contribution: output.value,
        detail: output.detail,
        durationMs,
        dslUsed: rule.condition?.dsl,
      });

      breakdown.push({
        ruleId: rule.id,
        contribution: output.value,
        modelUsed: model.name,
        detail: output.detail,
      });

      appliedRules.push(rule);
      totalValue = totalValue.plus(new Decimal(String(output.value)));
    }

    return { value: totalValue.toNumber(), breakdown, appliedRules };
  }
}
