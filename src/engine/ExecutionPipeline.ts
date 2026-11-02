import { DEFAULT_OUTPUT, DEFAULT_OUTPUT_DECLARATION } from '@run-iq/spec';
import type { JsonValue, OutputDeclaration } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { BreakdownItem, SkippedRule } from '../types/result.js';
import type { DecisionOutput } from '../types/output.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import { findNonJson, isJsonValue } from '../utils/json.js';
import { isPlainObject, ruleLabel } from '../utils/values.js';
import type { ShortCircuit } from './ExceptionProcessor.js';
import type { TraceBuilder } from './TraceBuilder.js';
import { OutputCombiner } from './OutputCombiner.js';
import type { Contribution } from './OutputCombiner.js';
import { compareByPriorityThenIdentity, compareRuleIdentity } from './resolveTie.js';
import {
  declarationKey,
  declarationOf,
  describeDeclaration,
  outputOf,
  refusesDeclaration,
} from './outputDeclaration.js';

export interface PipelineResult {
  /** Every output by name, in name order; `value` is always there (0 when no rule feeds it). */
  readonly outputs: Record<string, DecisionOutput> & { readonly value: DecisionOutput };
  /** One item per contribution that entered the decision, in the order of the trace steps. */
  readonly breakdown: BreakdownItem[];
  /** The rules whose computation or short-circuit entered the decision. */
  readonly applied: Rule[];
  /** The rules excluded here, by priority descending then id@version. */
  readonly skipped: SkippedRule[];
}

/** A contribution as the breakdown and the trace record it. */
interface Step {
  readonly rule: Rule;
  readonly output: string;
  readonly contribution: unknown;
  /** The contribution before rounding, when the output's rounding changed it. */
  readonly unrounded?: JsonValue;
  readonly modelUsed: string;
  readonly detail: unknown;
  readonly durationMs: number;
}

const sameRule = (a: Rule, b: Rule): boolean => a.id === b.id && a.version === b.version;

/**
 * Splits what a model returned into its value and detail. A plain object with an own `value` is
 * a `CalculationOutput`, except for an `object` output, where it must have no key other than
 * `value` and `detail`; anything else is the value itself.
 */
function readCalculation(
  raw: unknown,
  declaration: OutputDeclaration,
): { value: unknown; detail?: unknown } {
  if (isPlainObject(raw) && Object.hasOwn(raw, 'value')) {
    const wrapped =
      declaration.type !== 'object' ||
      Object.keys(raw).every((key) => key === 'value' || key === 'detail');
    if (wrapped) return { value: raw['value'], detail: raw['detail'] };
  }
  return { value: raw };
}

const emptyDefaultOutput = (): DecisionOutput => ({
  name: DEFAULT_OUTPUT,
  type: DEFAULT_OUTPUT_DECLARATION.type,
  combine: DEFAULT_OUTPUT_DECLARATION.combine,
  value: 0,
  contributors: [],
});

/**
 * Computes the rules and combines their contributions output by output (see `OutputCombiner`).
 *
 * - A short-circuited output takes the imposed value, read and rounded as a contribution would
 *   be (`OutputCombiner.impose`), with its carrier as only contributor. A
 *   carrier feeding its own short-circuited output is applied without being computed; any other
 *   rule left feeding it is skipped with `SHORT_CIRCUITED`.
 * - Rules feeding one output with different declarations (`model.output`, compared by
 *   `declarationKey`) are all skipped with `OUTPUT_MISMATCH`, without being computed, and the
 *   output is absent.
 * - A rule feeding `value` with a declaration other than a number is skipped with
 *   `OUTPUT_MISMATCH`, without being computed: `result.value` stays a number.
 * - A computed value that is not JSON is skipped with `OUTPUT_MISMATCH`, naming where.
 * - A step records the contribution as it entered the output (canonical for a `decimal`,
 *   rounded under `rounding.at: 'contribution'`), and `unrounded` only when rounding changed it.
 *
 * Applied rules, breakdown items and trace steps are by priority descending, then id@version,
 * then output name, whatever the order of `rules`.
 */
export class ExecutionPipeline {
  constructor(
    private readonly modelRegistry: ModelRegistry,
    private readonly conflictMode: 'throw' | 'first',
  ) {}

  execute(
    rules: ReadonlyArray<Rule>,
    input: EvaluationInput,
    traceBuilder: TraceBuilder,
    shortCircuits: ReadonlyMap<string, ShortCircuit>,
  ): PipelineResult {
    const outputs = new Map<string, DecisionOutput>();
    const steps: Step[] = [];
    const applied: Rule[] = [];
    const skipped: SkippedRule[] = [];

    // A short-circuit step may cite a carrier that a later stage skipped (dominance...): its
    // exceptions fired and are final. `detail.shortCircuit` marks these steps.
    for (const [name, shortCircuit] of shortCircuits) {
      const { rule, value, reason, declaration } = shortCircuit;
      const imposed = OutputCombiner.impose(name, declaration, rule, value);
      outputs.set(name, imposed.output);
      steps.push({
        rule,
        output: name,
        contribution: imposed.recorded.value,
        ...(imposed.recorded.unrounded === undefined
          ? {}
          : { unrounded: imposed.recorded.unrounded }),
        modelUsed: rule.model,
        detail: { shortCircuit: reason ?? null },
        durationMs: 0,
      });
    }

    const feeding = new Map<string, Rule[]>();
    for (const rule of [...rules].sort(compareByPriorityThenIdentity)) {
      const name = outputOf(rule);
      const shortCircuit = shortCircuits.get(name);
      if (shortCircuit === undefined) {
        const feeders = feeding.get(name);
        if (feeders === undefined) feeding.set(name, [rule]);
        else feeders.push(rule);
      } else if (sameRule(rule, shortCircuit.rule)) {
        applied.push(rule);
      } else {
        skipped.push({
          rule,
          reason: 'SHORT_CIRCUITED',
          detail: `output ${name} short-circuited by ${ruleLabel(shortCircuit.rule)}`,
        });
      }
    }

    for (const [name, candidates] of feeding) {
      const declared = [];
      for (const rule of candidates) {
        const declaration = declarationOf(this.modelRegistry, rule);
        if (refusesDeclaration(name, declaration)) {
          skipped.push({
            rule,
            reason: 'OUTPUT_MISMATCH',
            detail: `output ${name} must be a number: ${ruleLabel(rule)} declares it ${describeDeclaration(declaration)}`,
          });
        } else {
          declared.push({ rule, declaration });
        }
      }
      const feeders = declared.map((d) => d.rule);
      const [first] = declared;
      if (first === undefined) continue;
      const declaration = first.declaration;
      if (new Set(declared.map((d) => declarationKey(d.declaration))).size > 1) {
        const described = [...declared]
          .sort((a, b) => compareRuleIdentity(a.rule, b.rule))
          .map((d) => `${ruleLabel(d.rule)} ${describeDeclaration(d.declaration)}`)
          .join('; ');
        for (const rule of feeders) {
          skipped.push({
            rule,
            reason: 'OUTPUT_MISMATCH',
            detail: `rules feeding output ${name} declare it differently: ${described}`,
          });
        }
        continue;
      }

      const contributions: Contribution[] = [];
      const computed = new Map<Rule, Step>();
      for (const rule of feeders) {
        const model = this.modelRegistry.get(rule.model);
        const start = performance.now();
        const raw: unknown = model.calculate(input.data, rule, rule.params);
        const durationMs = Math.round((performance.now() - start) * 100) / 100;
        const { value, detail } = readCalculation(raw, declaration);
        if (!isJsonValue(value)) {
          skipped.push({
            rule,
            reason: 'OUTPUT_MISMATCH',
            detail: `output ${name}: the value is not JSON at ${findNonJson(value) ?? '$'}`,
          });
          continue;
        }
        contributions.push({ rule, value });
        computed.set(rule, {
          rule,
          output: name,
          contribution: value,
          modelUsed: model.name,
          detail,
          durationMs,
        });
      }

      const combined = OutputCombiner.combine(name, declaration, contributions, this.conflictMode);
      skipped.push(...combined.skipped);
      if (combined.output !== undefined) outputs.set(name, combined.output);
      for (const [rule, step] of computed) {
        const recorded = combined.recorded.get(rule);
        if (recorded === undefined) continue; // skipped by the combination
        applied.push(rule);
        steps.push({
          ...step,
          contribution: recorded.value,
          ...(recorded.unrounded === undefined ? {} : { unrounded: recorded.unrounded }),
        });
      }
    }

    steps.sort(
      (a, b) =>
        compareByPriorityThenIdentity(a.rule, b.rule) ||
        (a.output < b.output ? -1 : a.output > b.output ? 1 : 0),
    );
    for (const step of steps) {
      const { rule } = step;
      traceBuilder.addStep({
        ruleId: rule.id,
        ruleVersion: rule.version,
        output: step.output,
        ...(rule.sourceRef === undefined ? {} : { sourceRef: rule.sourceRef }),
        conditionResult: true,
        conditionDetail: rule.condition?.value ?? null,
        modelUsed: step.modelUsed,
        inputSnapshot: { ...input.data },
        contribution: step.contribution,
        ...(step.unrounded === undefined ? {} : { unrounded: step.unrounded }),
        detail: step.detail,
        durationMs: step.durationMs,
        dslUsed: rule.condition?.dsl,
      });
    }

    const value = outputs.get(DEFAULT_OUTPUT) ?? emptyDefaultOutput();
    outputs.set(DEFAULT_OUTPUT, value);
    const named = Object.fromEntries([...outputs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

    return {
      outputs: { ...named, value },
      breakdown: steps.map((step) => ({
        ruleId: step.rule.id,
        ruleVersion: step.rule.version,
        ...(step.rule.sourceRef === undefined ? {} : { sourceRef: step.rule.sourceRef }),
        output: step.output,
        contribution: step.contribution,
        ...(step.unrounded === undefined ? {} : { unrounded: step.unrounded }),
        modelUsed: step.modelUsed,
        detail: step.detail,
      })),
      applied: applied.sort(compareByPriorityThenIdentity),
      skipped: skipped.sort((a, b) => compareByPriorityThenIdentity(a.rule, b.rule)),
    };
  }
}
