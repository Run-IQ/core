import {
  DEFAULT_OUTPUT,
  DEFAULT_OUTPUT_DECLARATION,
  EXCEPTION_MODEL,
  canonicalize,
  matchesSelector,
  valueMatchesOutputType,
} from '@run-iq/spec';
import type {
  JsonValue,
  OutputDeclaration,
  ProofException,
  RuleException,
  RuleSelector,
} from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import { deepMerge } from '../utils/deepMerge.js';
import { compareRuleIdentity, resolveTie } from './resolveTie.js';

type Substitute = Extract<RuleException, { kind: 'substitute' }>;
type ShortCircuitException = Extract<RuleException, { kind: 'shortCircuit' }>;

/** The value a `shortCircuit` imposes on an output, and the rule that carries it. */
export interface ShortCircuit {
  readonly rule: Rule;
  readonly value: JsonValue;
  readonly reason?: string;
}

export interface ExceptionResult {
  /**
   * The rules left to evaluate, by priority descending then id@version. A substituted rule is a
   * copy with the merged `params`; the others are the input objects. `EXCEPTION_MODEL` rules are
   * never in it.
   */
  readonly rules: Rule[];
  /** The rules the exceptions excluded, by priority descending then id@version. */
  readonly skipped: SkippedRule[];
  /** The short-circuited outputs, by output name, in processing order. */
  readonly shortCircuits: Map<string, ShortCircuit>;
  /**
   * The exceptions that took effect, as the proof records them: by carrier in processing order,
   * then in the carrier's own order. `affected` lists, sorted, the ids of the rules each one acted
   * on (excluded, inhibited or substituted). A short-circuit that won its output is always listed,
   * even with no rule to exclude.
   */
  readonly applied: ProofException[];
}

/** A rule whose exceptions fire, with the static targets of each of them. */
interface Carrier {
  readonly rule: Rule;
  readonly exceptions: readonly RuleException[];
  /** For each exception index, the rules its selector matches (other than the carrier). */
  readonly targets: ReadonlyMap<number, readonly Rule[]>;
}

const byPriorityThenIdentity = (a: Rule, b: Rule): number =>
  b.priority - a.priority || compareRuleIdentity(a, b);

const label = (rule: Rule): string => `${rule.id}@${rule.version}`;

const outputOf = (rule: Rule): string => rule.output ?? DEFAULT_OUTPUT;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when both params set one key path to values that differ (canonically). */
function paramsConflict(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key of Object.keys(a)) {
    if (!Object.hasOwn(b, key)) continue;
    const left = a[key];
    const right = b[key];
    if (isPlainObject(left) && isPlainObject(right)) {
      if (paramsConflict(left, right)) return true;
    } else if (canonicalize(left) !== canonicalize(right)) {
      return true;
    }
  }
  return false;
}

function describeDeclaration(declaration: OutputDeclaration): string {
  return declaration.values === undefined
    ? declaration.type
    : `${declaration.type} (${declaration.values.join(', ')})`;
}

/**
 * Applies the native rule exceptions (`inhibit`, `substitute`, `shortCircuit`) of a set of rules.
 *
 * Rules are processed by priority descending, then id@version. When its turn comes, a rule that
 * is already excluded fires nothing (an inhibited exception does not fire its own exceptions:
 * exceptions of exceptions). Otherwise its exceptions fire, unless:
 * - one of its short-circuit values does not match the declaration of that output: the rule is
 *   skipped with `OUTPUT_MISMATCH`;
 * - it conflicts with a rule of the same priority that already fired (a short-circuit of the same
 *   output, or a substitution setting a key of a common target to another value): `resolveTie`
 *   throws or skips it with `RULE_CONFLICT`.
 *
 * Then short-circuits apply first (the rules of a short-circuited output are `SHORT_CIRCUITED`,
 * even if also inhibited), then inhibitions (`INHIBITED`), then substitutions on the remaining
 * rules, deep-merged by priority ascending so that the highest priority writes last. Substituted
 * params that the rule's model refuses skip it with `INVALID_PARAMS`.
 *
 * Processing is sequential: a lower-priority rule may still inhibit a higher-priority one, which
 * is then excluded, but whose own exceptions have already fired.
 */
export class ExceptionProcessor {
  constructor(private readonly models: ModelRegistry) {}

  apply(rules: ReadonlyArray<Rule>, mode: 'throw' | 'first'): ExceptionResult {
    const ordered = [...rules].sort(byPriorityThenIdentity);
    /** Exclusions decided during the pass: INHIBITED, RULE_CONFLICT, OUTPUT_MISMATCH. */
    const excluded = new Map<Rule, SkippedRule>();
    const inhibitedBy = new Map<Rule, { carrier: Rule; index: number }>();
    const fired: Carrier[] = [];
    const claims = new Map<
      string,
      { carrier: Rule; index: number; exception: ShortCircuitException }
    >();

    for (const rule of ordered) {
      const exceptions = rule.exceptions ?? [];
      if (exceptions.length === 0 || excluded.has(rule)) continue;

      const mismatch = this.findOutputMismatch(rule, exceptions, ordered);
      if (mismatch !== undefined) {
        excluded.set(rule, { rule, reason: 'OUTPUT_MISMATCH', detail: mismatch });
        continue;
      }

      const carrier = this.describeCarrier(rule, exceptions, ordered);
      const rivals = fired.filter((other) => conflicts(carrier, other));
      if (rivals.length > 0) {
        // Rivals fired first, so they precede `rule` in identity order: `rule` always loses.
        const { losers } = resolveTie([...rivals.map((r) => r.rule), rule], mode);
        const loss = losers.find((loser) => loser.rule === rule);
        if (loss !== undefined) excluded.set(rule, loss);
        continue;
      }

      exceptions.forEach((exception, index) => {
        if (exception.kind === 'shortCircuit') {
          if (!claims.has(exception.output)) {
            claims.set(exception.output, { carrier: rule, index, exception });
          }
        } else if (exception.kind === 'inhibit') {
          for (const target of carrier.targets.get(index) ?? []) {
            if (excluded.has(target)) continue;
            excluded.set(target, {
              rule: target,
              reason: 'INHIBITED',
              detail: `inhibited by ${label(rule)}`,
            });
            inhibitedBy.set(target, { carrier: rule, index });
          }
        }
      });
      fired.push(carrier);
    }

    // Short-circuits first: they take precedence over an inhibition of the same rule.
    const final = new Map(excluded);
    const shortCircuits = new Map<string, ShortCircuit>();
    const shortCircuited = new Map<string, Rule[]>();
    for (const [output, { carrier, exception }] of claims) {
      shortCircuits.set(
        output,
        exception.reason === undefined
          ? { rule: carrier, value: exception.value }
          : { rule: carrier, value: exception.value, reason: exception.reason },
      );
      const affected = ordered.filter((target) => {
        if (target === carrier || target.model === EXCEPTION_MODEL) return false;
        if (outputOf(target) !== output) return false;
        const reason = excluded.get(target)?.reason;
        return reason === undefined || reason === 'INHIBITED';
      });
      for (const target of affected) {
        final.set(target, {
          rule: target,
          reason: 'SHORT_CIRCUITED',
          detail: `output ${output} short-circuited by ${label(carrier)}`,
        });
      }
      shortCircuited.set(output, affected);
    }

    // Substitutions on the remaining rules, lowest priority first.
    const substitutedBy = new Map<string, Rule[]>();
    const kept: Rule[] = [];
    for (const target of ordered) {
      if (final.has(target) || target.model === EXCEPTION_MODEL) continue;
      const patches: { carrier: Rule; index: number; exception: Substitute }[] = [];
      for (const { rule, exceptions, targets } of [...fired].reverse()) {
        exceptions.forEach((exception, index) => {
          if (exception.kind === 'substitute' && targets.get(index)?.includes(target)) {
            patches.push({ carrier: rule, index, exception });
          }
        });
      }
      if (patches.length === 0) {
        kept.push(target);
        continue;
      }
      for (const { carrier, index } of patches) {
        const key = `${fired.findIndex((c) => c.rule === carrier)}:${index}`;
        substitutedBy.set(key, [...(substitutedBy.get(key) ?? []), target]);
      }
      const params = patches.reduce<unknown>(
        (merged, { exception }) => deepMerge(merged, exception.params),
        target.params,
      );
      const refusal = this.refuseParams(target, params);
      if (refusal !== undefined) {
        const by = [...new Set(patches.map((p) => label(p.carrier)))].join(', ');
        final.set(target, {
          rule: target,
          reason: 'INVALID_PARAMS',
          detail: `after substitution by ${by}: ${refusal}`,
        });
        continue;
      }
      kept.push({ ...target, params });
    }

    const applied: ProofException[] = [];
    fired.forEach(({ rule, exceptions }, carrierIndex) => {
      exceptions.forEach((exception, index) => {
        let affected: Rule[] | undefined;
        if (exception.kind === 'inhibit') {
          affected = [...inhibitedBy]
            .filter(([, by]) => by.carrier === rule && by.index === index)
            .map(([target]) => target);
          if (affected.length === 0) return;
        } else if (exception.kind === 'substitute') {
          affected = substitutedBy.get(`${carrierIndex}:${index}`);
          if (affected === undefined) return;
        } else {
          const claim = claims.get(exception.output);
          if (claim?.carrier !== rule || claim.index !== index) return;
          affected = shortCircuited.get(exception.output) ?? [];
        }
        applied.push({
          ruleId: rule.id,
          version: rule.version,
          kind: exception.kind,
          affected: sortedIds(affected),
        });
      });
    });

    return {
      rules: kept,
      skipped: ordered.flatMap((rule) => {
        const skip = final.get(rule);
        return skip === undefined ? [] : [skip];
      }),
      shortCircuits,
      applied,
    };
  }

  /** The detail of the first short-circuit of `rule` whose value its output's declaration refuses. */
  private findOutputMismatch(
    rule: Rule,
    exceptions: readonly RuleException[],
    ordered: readonly Rule[],
  ): string | undefined {
    for (const exception of exceptions) {
      if (exception.kind !== 'shortCircuit') continue;
      for (const declaration of this.declarationsOf(exception.output, ordered)) {
        if (!valueMatchesOutputType(exception.value, declaration)) {
          return (
            `shortCircuit of ${label(rule)} on output ${exception.output}: value ` +
            `${canonicalize(exception.value)} does not match type ${describeDeclaration(declaration)}`
          );
        }
      }
    }
    return undefined;
  }

  /**
   * The declarations of `output`: those of the rules feeding it (whose model is registered), or
   * `DEFAULT_OUTPUT_DECLARATION` for the default output when no rule feeds it.
   */
  private declarationsOf(output: string, ordered: readonly Rule[]): OutputDeclaration[] {
    const declarations: OutputDeclaration[] = [];
    for (const rule of ordered) {
      if (rule.model === EXCEPTION_MODEL || outputOf(rule) !== output) continue;
      if (!this.models.has(rule.model)) continue;
      const declaration = this.models.get(rule.model).output ?? DEFAULT_OUTPUT_DECLARATION;
      if (!declarations.includes(declaration)) declarations.push(declaration);
    }
    if (declarations.length === 0 && output === DEFAULT_OUTPUT) {
      declarations.push(DEFAULT_OUTPUT_DECLARATION);
    }
    return declarations;
  }

  private describeCarrier(
    rule: Rule,
    exceptions: readonly RuleException[],
    ordered: readonly Rule[],
  ): Carrier {
    const targets = new Map<number, Rule[]>();
    exceptions.forEach((exception, index) => {
      if (exception.kind === 'shortCircuit') return;
      targets.set(
        index,
        ordered.filter(
          (target) =>
            target !== rule &&
            !(exception.kind === 'substitute' && target.model === EXCEPTION_MODEL) &&
            selects(target, exception.targets),
        ),
      );
    });
    return { rule, exceptions, targets };
  }

  /** Why the rule's model refuses `params`, or `undefined` if it accepts them or is unknown. */
  private refuseParams(rule: Rule, params: unknown): string | undefined {
    if (!this.models.has(rule.model)) return undefined;
    const model = this.models.get(rule.model);
    const validation = model.validateParams(params);
    if (validation.valid) return undefined;
    return validation.errors?.length
      ? validation.errors.join('; ')
      : `params refused by model ${model.name}`;
  }
}

/**
 * True when `rule` is one `selector` targets. An `EXCEPTION_MODEL` rule has no output, so a
 * selector on `outputs` never matches it.
 */
function selects(rule: Rule, selector: RuleSelector): boolean {
  if (rule.model === EXCEPTION_MODEL && selector.outputs?.length) return false;
  return matchesSelector(
    {
      id: rule.id,
      tags: rule.tags,
      dimensions: rule.dimensions ?? {},
      model: rule.model,
      ...(rule.output === undefined ? {} : { output: rule.output }),
    },
    selector,
  );
}

/** True when two carriers of the same priority fire contradictory exceptions. */
function conflicts(a: Carrier, b: Carrier): boolean {
  if (a.rule.priority !== b.rule.priority) return false;
  const shortCircuitOutputs = (c: Carrier): string[] =>
    c.exceptions.flatMap((e) => (e.kind === 'shortCircuit' ? [e.output] : []));
  const outputsOfB = shortCircuitOutputs(b);
  if (shortCircuitOutputs(a).some((output) => outputsOfB.includes(output))) return true;

  const substitutions = (
    c: Carrier,
  ): { params: Substitute['params']; targets: readonly Rule[] }[] =>
    c.exceptions.flatMap((e, index) =>
      e.kind === 'substitute' ? [{ params: e.params, targets: c.targets.get(index) ?? [] }] : [],
    );
  const ofB = substitutions(b);
  return substitutions(a).some((left) =>
    ofB.some(
      (right) =>
        left.targets.some((target) => right.targets.includes(target)) &&
        paramsConflict(left.params, right.params),
    ),
  );
}

function sortedIds(rules: readonly Rule[]): string[] {
  return [...new Set(rules.map((rule) => rule.id))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
