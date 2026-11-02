import {
  DEFAULT_OUTPUT,
  DEFAULT_OUTPUT_DECLARATION,
  EXCEPTION_MODEL,
  canonicalize,
  matchesSelector,
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
import { ExceptionPrecedenceError } from '../errors/ExceptionPrecedenceError.js';
import { deepMerge } from '../utils/deepMerge.js';
import { compareByPriorityThenIdentity, resolveTie } from './resolveTie.js';
import { isPlainObject, ruleLabel } from '../utils/values.js';
import {
  declarationKey,
  declarationOf,
  describeDeclaration,
  describeMismatch,
  outputOf,
  readOutputValue,
  refusesDeclaration,
} from './outputDeclaration.js';

/**
 * An exception as core records it before 9M2 (`status`, `stratum`) and Task 10 (`salt`) settle
 * and seal it: spec's `ProofException` without those three. Derived from it, so every other
 * member stays in sync; those tasks delete this alias.
 */
export type UnsettledException = Omit<ProofException, 'status' | 'stratum' | 'salt'>;

type Substitute = Extract<RuleException, { kind: 'substitute' }>;
type ShortCircuitException = Extract<RuleException, { kind: 'shortCircuit' }>;

/** The value a `shortCircuit` imposes on an output, and the rule that carries it. */
export interface ShortCircuit {
  readonly rule: Rule;
  readonly value: JsonValue;
  readonly reason?: string;
  /**
   * The declaration of the output, which accepts `value` (`readOutputValue`; see
   * `ExceptionProcessor`). The value is as the exception wrote it: the pipeline normalizes and
   * rounds it (`OutputCombiner.impose`).
   */
  readonly declaration: OutputDeclaration;
}

/**
 * What the exceptions did. Every input rule is in exactly one of `rules` and `skipped`, except an
 * `EXCEPTION_MODEL` rule that fired, which is in neither and has its records in `applied`.
 *
 * Of the skip reasons, `INHIBITED`, `RULE_CONFLICT` and `OUTPUT_MISMATCH` (of a carrier) stop a
 * rule from firing its exceptions. `SHORT_CIRCUITED` and `INVALID_PARAMS` bear only on the
 * rule's own computation: a carrier skipped for them has still fired its exceptions.
 */
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
   * Every exception of every rule that fired, as the proof records it: by carrier in processing
   * order, then in the carrier's own order. `affected` lists, sorted by id, the `{ ruleId }` of the
   * rules each one acted on (excluded, inhibited or substituted), possibly none: an inhibit whose targets
   * were already excluded, a substitution of excluded rules, or a short-circuit outranked on its
   * output (the winner is the one in `shortCircuits`).
   */
  readonly applied: UnsettledException[];
}

/** A rule whose exceptions fire, with the static targets of each of them. */
interface Carrier {
  readonly rule: Rule;
  readonly exceptions: readonly RuleException[];
  /** For each exception index, the rules its selector matches (other than the carrier). */
  readonly targets: ReadonlyMap<number, readonly Rule[]>;
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

/**
 * Applies the native rule exceptions (`inhibit`, `substitute`, `shortCircuit`) of a set of rules.
 *
 * Rules are processed once, by priority descending then id@version, and the effects of a rule
 * that fired are final. When its turn comes, a rule already excluded fires nothing (an inhibited
 * exception does not fire its own exceptions: exceptions of exceptions). Otherwise it fires,
 * unless:
 * - one of its short-circuit values does not match the declaration of that output (the
 *   declaration of the rules in play feeding it; `DEFAULT_OUTPUT_DECLARATION` for `value` when
 *   none does), or no rule in play declares that output, or they declare it differently: it is
 *   skipped with `OUTPUT_MISMATCH`. A value matches as a contribution would
 *   (`readOutputValue`: a `decimal` takes a decimal string or a safe integer);
 * - it inhibits a carrier that already fired, i.e. one that takes precedence over it: this is a
 *   precedence conflict, which throws `ExceptionPrecedenceError` in `throw` mode and skips it with
 *   `RULE_CONFLICT` in `first` mode. Inhibiting a rule without exceptions, or a carrier not yet
 *   reached, is allowed at any priority;
 * - it conflicts with a rule of the same priority that already fired (a short-circuit of the
 *   same output, or a substitution setting a key of a common target, not yet excluded, to another
 *   value): `resolveTie` throws, naming every rule of the tie, or skips it with `RULE_CONFLICT`.
 *
 * Then short-circuits apply first (the rules of a short-circuited output are `SHORT_CIRCUITED`,
 * even if also inhibited, which the detail says), then inhibitions (`INHIBITED`), then
 * substitutions on the remaining rules, deep-merged by priority ascending so that the highest
 * priority writes last. Substituted params that the rule's model refuses skip it with
 * `INVALID_PARAMS`.
 */
export class ExceptionProcessor {
  constructor(private readonly models: ModelRegistry) {}

  apply(rules: ReadonlyArray<Rule>, mode: 'throw' | 'first'): ExceptionResult {
    const ordered = [...rules].sort(compareByPriorityThenIdentity);
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
      const precedent = firedTargetOf(carrier, fired);
      if (precedent !== undefined) {
        if (mode === 'throw') {
          throw new ExceptionPrecedenceError(
            rule.id,
            precedent.id,
            ruleLabel(rule),
            ruleLabel(precedent),
          );
        }
        excluded.set(rule, {
          rule,
          reason: 'RULE_CONFLICT',
          detail: `inhibits ${ruleLabel(precedent)}, which takes precedence and already fired`,
        });
        continue;
      }

      const rivals = fired.filter((other) => conflicts(carrier, other, excluded));
      if (rivals.length > 0) {
        const tie = [...rivals.map((r) => r.rule), rule];
        if (mode === 'throw') {
          resolveTie(this.wholeTie(tie, ordered, excluded), 'throw');
        }
        // Rivals fired first, so they precede `rule` in identity order: `rule` always loses.
        const { losers } = resolveTie(tie, mode);
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
              detail: `inhibited by ${ruleLabel(rule)}`,
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
      // A claim passed findOutputMismatch: its output has exactly one declaration.
      const [declaration] = this.declarationsOf(output, ordered);
      if (declaration === undefined) {
        throw new Error(
          `short-circuit of ${ruleLabel(carrier)} on output ${output} has no declaration`,
        );
      }
      shortCircuits.set(
        output,
        exception.reason === undefined
          ? { rule: carrier, value: exception.value, declaration }
          : { rule: carrier, value: exception.value, reason: exception.reason, declaration },
      );
      const affected = ordered.filter((target) => {
        if (target === carrier || target.model === EXCEPTION_MODEL) return false;
        if (outputOf(target) !== output) return false;
        const reason = excluded.get(target)?.reason;
        return reason === undefined || reason === 'INHIBITED';
      });
      for (const target of affected) {
        const inhibitor = inhibitedBy.get(target)?.carrier;
        final.set(target, {
          rule: target,
          reason: 'SHORT_CIRCUITED',
          detail:
            `output ${output} short-circuited by ${ruleLabel(carrier)}` +
            (inhibitor === undefined ? '' : `; also inhibited by ${ruleLabel(inhibitor)}`),
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
        const by = [...new Set(patches.map((p) => ruleLabel(p.carrier)))].join(', ');
        final.set(target, {
          rule: target,
          reason: 'INVALID_PARAMS',
          detail: `after substitution by ${by}: ${refusal}`,
        });
        continue;
      }
      kept.push({ ...target, params });
    }

    const applied: UnsettledException[] = [];
    fired.forEach(({ rule, exceptions }, carrierIndex) => {
      exceptions.forEach((exception, index) => {
        let affected: readonly Rule[];
        if (exception.kind === 'inhibit') {
          affected = [...inhibitedBy]
            .filter(([, by]) => by.carrier === rule && by.index === index)
            .map(([target]) => target);
        } else if (exception.kind === 'substitute') {
          affected = substitutedBy.get(`${carrierIndex}:${index}`) ?? [];
        } else {
          const claim = claims.get(exception.output);
          const won = claim?.carrier === rule && claim.index === index;
          affected = won ? (shortCircuited.get(exception.output) ?? []) : [];
        }
        applied.push({
          ruleId: rule.id,
          version: rule.version,
          kind: exception.kind,
          // The output a short circuit targets, which spec's validateProof requires.
          ...(exception.kind === 'shortCircuit' ? { output: exception.output } : {}),
          affected: sortedIds(affected).map((ruleId) => ({ ruleId })),
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

  /**
   * Every rule of the tie `seed` belongs to: the carriers of the same priority, not excluded,
   * that conflict with one of its rules, transitively. Only `throw` mode needs it, to name them.
   * Candidates not yet reached count as they stand now, so the error may name a same-priority
   * rival that a later same-priority rule would have inhibited: deterministic, it errs on naming
   * more.
   */
  private wholeTie(
    seed: readonly Rule[],
    ordered: readonly Rule[],
    excluded: ReadonlyMap<Rule, SkippedRule>,
  ): Rule[] {
    const priority = seed[0]?.priority;
    const candidates = ordered
      .filter(
        (rule) =>
          rule.priority === priority && (rule.exceptions?.length ?? 0) > 0 && !excluded.has(rule),
      )
      .map((rule) => this.describeCarrier(rule, rule.exceptions ?? [], ordered));
    const tie = candidates.filter((c) => seed.includes(c.rule));
    for (let grown = true; grown;) {
      grown = false;
      for (const candidate of candidates) {
        if (tie.includes(candidate)) continue;
        if (tie.some((member) => conflicts(candidate, member, excluded))) {
          tie.push(candidate);
          grown = true;
        }
      }
    }
    return tie.map((c) => c.rule);
  }

  /** The detail of the first short-circuit of `rule` that its output's declarations refuse. */
  private findOutputMismatch(
    rule: Rule,
    exceptions: readonly RuleException[],
    ordered: readonly Rule[],
  ): string | undefined {
    for (const exception of exceptions) {
      if (exception.kind !== 'shortCircuit') continue;
      const { output, value } = exception;
      const at = `shortCircuit of ${ruleLabel(rule)} on output ${output}`;
      const declarations = this.declarationsOf(output, ordered);
      const [declaration] = declarations;
      if (declaration === undefined) return `${at}: no rule in play declares output ${output}`;
      if (declarations.length > 1) {
        const described = declarations.map(describeDeclaration).sort();
        return `${at}: the rules feeding it declare it differently (${described.join(', ')})`;
      }
      if (readOutputValue(value, declaration) === undefined) {
        return `${at}: ${describeMismatch(value, declaration)}`;
      }
    }
    return undefined;
  }

  /**
   * The distinct declarations of `output` among the rules in play feeding it (whose model is
   * registered), each `declarationOf` it, compared by `declarationKey`, except those
   * `refusesDeclaration` refuses; for the default output with no such rule,
   * `DEFAULT_OUTPUT_DECLARATION`.
   */
  private declarationsOf(output: string, ordered: readonly Rule[]): OutputDeclaration[] {
    const declarations = new Map<string, OutputDeclaration>();
    for (const rule of ordered) {
      if (rule.model === EXCEPTION_MODEL || outputOf(rule) !== output) continue;
      if (!this.models.has(rule.model)) continue;
      const declaration = declarationOf(this.models, rule);
      // Such a rule is excluded by the pipeline and does not type the output.
      if (refusesDeclaration(output, declaration)) continue;
      declarations.set(declarationKey(declaration), declaration);
    }
    if (declarations.size === 0 && output === DEFAULT_OUTPUT) {
      return [DEFAULT_OUTPUT_DECLARATION];
    }
    return [...declarations.values()];
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

/** The first carrier that already fired among the targets of the inhibitions of `carrier`. */
function firedTargetOf(carrier: Carrier, fired: readonly Carrier[]): Rule | undefined {
  for (const [index, targets] of carrier.targets) {
    if (carrier.exceptions[index]?.kind !== 'inhibit') continue;
    const target = targets.find((t) => fired.some((f) => f.rule === t));
    if (target !== undefined) return target;
  }
  return undefined;
}

/**
 * True when two carriers of the same priority fire contradictory exceptions: a short-circuit of
 * the same output, or substitutions setting one key of a common target, not yet excluded, to
 * different values.
 */
function conflicts(a: Carrier, b: Carrier, excluded: ReadonlyMap<Rule, SkippedRule>): boolean {
  if (a.rule.priority !== b.rule.priority) return false;
  const shortCircuitOutputs = (c: Carrier): string[] =>
    c.exceptions.flatMap((e) => (e.kind === 'shortCircuit' ? [e.output] : []));
  const outputsOfB = shortCircuitOutputs(b);
  if (shortCircuitOutputs(a).some((output) => outputsOfB.includes(output))) return true;

  const substitutions = (
    c: Carrier,
  ): { params: Substitute['params']; targets: readonly Rule[] }[] =>
    c.exceptions.flatMap((e, index) =>
      e.kind === 'substitute'
        ? [
            {
              params: e.params,
              targets: (c.targets.get(index) ?? []).filter((t) => !excluded.has(t)),
            },
          ]
        : [],
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
