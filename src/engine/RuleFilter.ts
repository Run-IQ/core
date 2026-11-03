import { ViewScope } from './frozenView.js';
import type { Rule } from '../types/rule.js';
import type { EvaluationInput } from '../types/input.js';
import type { Diagnostic } from '../types/diagnostic.js';
import type { SkippedRule } from '../types/result.js';
import type { DSLRegistry } from '../registry/DSLRegistry.js';
import type { PluginSandbox } from '../security/PluginSandbox.js';
import {
  SpecError,
  canonicalize,
  comparePointers,
  isEffectiveAt,
  matchDimension,
  parsePointer,
} from '@run-iq/spec';
import type { DimensionSpec, Referential } from '@run-iq/spec';
import { DSLEvaluationError } from '../errors/DSLEvaluationError.js';
import { isRaisedLimit } from '../errors/EngineLimitError.js';
import { defaultCrossing, readVerdict } from './pluginBoundary.js';
import type { Crossing } from './pluginBoundary.js';
import { clip } from '../utils/frozenCopy.js';
import { ruleLabel } from '../utils/values.js';
import { buildContext } from '../context/buildContext.js';
import { readsOf } from '../context/reads.js';
import { normalizeMeta } from '../input/normalizeMeta.js';
import type { NormalizedMeta } from '../input/normalizeMeta.js';

export interface FilterResult {
  readonly passed: readonly Rule[];
  readonly skipped: readonly SkippedRule[];
  /**
   * The pointers of the evaluation context (`/revenue/total`, `/$dates/effective`) read by the
   * evaluated conditions but absent from it, unique, sorted by `comparePointers`.
   */
  readonly missingFacts: readonly string[];
  /** Non-fatal problems met while filtering (a `listVariables` that does not conform). */
  readonly diagnostics: readonly Diagnostic[];
}

type Exclusion = Pick<SkippedRule, 'reason'> & { readonly detail: string };

/** Where a rule is filtered: the canonical meta, and the context its conditions are given. */
interface Scope {
  readonly input: EvaluationInput;
  readonly meta: NormalizedMeta;
  readonly context: Readonly<Record<string, unknown>>;
}

/** A list index as D-1 writes it: `0` or digits without a leading zero. */
const LIST_INDEX = /^(0|[1-9][0-9]*)$/;

/** The engine variables whose facts are in the context before any rule runs. */
const KNOWN_VARIABLES: ReadonlySet<string> = new Set(['$dates', '$dimensions']);

/**
 * True when the fact at `pointer` is absent from `context`: resolved segment by segment on own
 * properties only (an inherited property, `length` of a list, is not a fact), a list element by
 * its canonical index (`01` names nothing, a hole is absent), a value that is `undefined` absent,
 * a path through a non-object absent. The root is never absent. An engine variable that is not
 * built yet (`$outputs`, `$item`, `$params`...) is not a fact: it is not asked about here.
 */
function isMissing(context: Readonly<Record<string, unknown>>, pointer: string): boolean {
  const segments = parsePointer(pointer);
  const [head] = segments;
  if (head === undefined) return false;
  if (head.startsWith('$') && !KNOWN_VARIABLES.has(head)) return false;
  let current: unknown = context;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      // `Number('01')` is 1, but `01` names no element: only the canonical index text does.
      const index = LIST_INDEX.test(segment) ? Number(segment) : -1;
      if (!Object.hasOwn(current, index)) return true;
      current = current[index];
    } else if (typeof current === 'object' && current !== null) {
      if (!Object.prototype.propertyIsEnumerable.call(current, segment)) return true;
      current = Reflect.get(current, segment);
    } else {
      return true;
    }
  }
  return current === undefined;
}

/** The input values of a dimension as the detail names them: one value, or `[a, b]`. */
const describeInput = (value: string | readonly string[]): string =>
  typeof value === 'string' ? value : `[${value.join(', ')}]`;

/** The referentials the dimension filter can resolve a `ref` in: none until 9Q provides them. */
const NO_REFERENTIALS: ReadonlyMap<string, Referential> = new Map();

/** A rule's dimension as the detail names it: a plain value as written, a spec in JSON. */
const describeSpec = (spec: DimensionSpec): string =>
  typeof spec === 'string' ? spec : canonicalize(spec);

/** A window that holds every instant: it only makes spec check the date it is asked about. */
const ALWAYS_OPEN = { effectiveFrom: new Date(0), effectiveUntil: null };

/** The exclusion of a rule that spec refuses: its code and message, as spec words them. */
function invalidRule(rule: Rule, error: SpecError, where = ''): Exclusion {
  return {
    reason: 'INVALID_RULE',
    detail: `Invalid rule ${rule.id}@${rule.version}: ${where}${error.code}: ${error.message}`,
  };
}

/** A bound as the detail names it: a civil date as written, an instant in ISO form. */
function formatDate(date: string | Date): string {
  if (typeof date === 'string') return date;
  return Number.isNaN(date.getTime()) ? 'Invalid Date' : date.toISOString();
}

export class RuleFilter {
  constructor(
    private readonly dslRegistry: DSLRegistry,
    private readonly sandbox: PluginSandbox,
    private readonly crossing: Crossing = defaultCrossing(),
  ) {}

  /**
   * Filters `rules` for `input` at `now`. `meta` is the canonical meta of `input` when the caller
   * already has it (the engine does); otherwise it is written here (`normalizeMeta`).
   */
  async filter(
    rules: ReadonlyArray<Rule>,
    input: EvaluationInput,
    now: Date,
    meta?: NormalizedMeta,
  ): Promise<FilterResult> {
    // The evaluation date is an input: an invalid one rejects the evaluation with spec's own
    // error (INVALID_DATE), before any rule. A fault after this point is a rule's bound.
    isEffectiveAt(ALWAYS_OPEN, now);
    const canonical = meta ?? normalizeMeta(input.meta);
    // No output exists while rules are filtered: the context is the same for every rule.
    const context = buildContext(
      { data: input.data, dates: canonical.dates, dimensions: canonical.dimensions },
      { outputs: [] },
    );
    const scope: Scope = { input, meta: canonical, context };
    const passed: Rule[] = [];
    const skipped: SkippedRule[] = [];
    const missing = new Set<string>();
    const diagnostics: Diagnostic[] = [];

    for (const rule of rules) {
      const exclusion = await this.checkRule(rule, scope, now, missing, diagnostics);
      if (exclusion) {
        skipped.push({ rule, reason: exclusion.reason, detail: exclusion.detail });
      } else {
        passed.push(rule);
      }
    }

    return { passed, skipped, missingFacts: [...missing].sort(comparePointers), diagnostics };
  }

  private async checkRule(
    rule: Rule,
    scope: Scope,
    now: Date,
    missing: Set<string>,
    diagnostics: Diagnostic[],
  ): Promise<Exclusion | null> {
    // 1. Date filter: half-open window [effectiveFrom, effectiveUntil)
    let active: boolean;
    try {
      active = isEffectiveAt(rule, now);
    } catch (error) {
      // The rule's own fault (a bound spec refuses, a civil bound with an IANA zone): it is
      // skipped; the others go on.
      if (!(error instanceof SpecError)) throw error;
      return invalidRule(rule, error);
    }
    if (!active) {
      const until = rule.effectiveUntil === null ? 'infinity' : formatDate(rule.effectiveUntil);
      return {
        reason: 'INACTIVE_DATE',
        detail: `window [${formatDate(rule.effectiveFrom)}, ${until}), evaluated at ${formatDate(now)}`,
      };
    }

    // 2. Tag filter
    const inputTags = scope.input.meta.tags;
    if (inputTags && inputTags.length > 0 && rule.tags.length > 0) {
      const hasIntersection = rule.tags.some((tag) => inputTags.includes(tag));
      if (!hasIntersection) {
        return {
          reason: 'TAG_MISMATCH',
          detail: `rule tags [${rule.tags.join(', ')}], input tags [${inputTags.join(', ')}]`,
        };
      }
    }

    // 3. Dimension filter (only when the input declares dimensions), by spec's matchDimension
    const inputDimensions = scope.meta.dimensions;
    // The gate is the canonical meta, the one that is recorded: an input decides by it alone.
    if (Object.keys(inputDimensions).length > 0 && rule.dimensions !== undefined) {
      // The civil date of the evaluation, in UTC: 9P refines it (the rule's reference date).
      const on = now.toISOString().slice(0, 10);
      for (const [key, spec] of Object.entries(rule.dimensions)) {
        const actual = Object.hasOwn(inputDimensions, key) ? inputDimensions[key] : undefined;
        const rulePart = `${key}: rule ${describeSpec(spec)}`;
        if (actual === undefined) {
          return { reason: 'DIMENSION_MISMATCH', detail: `${rulePart}, input has no ${key}` };
        }
        let match: ReturnType<typeof matchDimension>;
        try {
          match = matchDimension(spec, actual, on, NO_REFERENTIALS);
        } catch (error) {
          if (!(error instanceof SpecError)) throw error;
          // An input value spec cannot read is the input's fault: the evaluation is rejected
          // with spec's error, unchanged. Anything else is the rule's (a spec or a referential
          // it names): the rule is skipped, never counted as a mismatch.
          if (error.code === 'INVALID_INPUT') throw error;
          return invalidRule(rule, error, `dimension ${key}: `);
        }
        if (match.result !== true) {
          // An `unknown` membership excludes the rule: core's choice, 9Q decides it.
          const unknown = match.result === 'unknown' ? ` (unknown: ${match.why})` : '';
          return {
            reason: 'DIMENSION_MISMATCH',
            detail: `${rulePart}, input ${describeInput(actual)}${unknown}`,
          };
        }
      }
    }

    // 4. DSL condition filter
    if (rule.condition) {
      const evaluator = this.dslRegistry.get(rule.condition.dsl);
      if (!evaluator) {
        return { reason: 'DSL_NOT_FOUND', detail: `DSL not found: ${rule.condition.dsl}` };
      }

      // The reads only feed missingFacts: a listVariables that does not conform never changes the
      // rule's outcome. Until 9M1 adds the `provisional` status, a rule whose `listVariables`
      // failed (`reads.declared` false) is evaluated, its reads unknown: only the diagnostic
      // says so, and its absent facts are not in `missingFacts`.
      const reads = readsOf(rule, evaluator, undefined, this.crossing);
      for (const problem of reads.problems) {
        diagnostics.push({ source: 'engine', message: problem.message });
      }
      for (const pointer of reads.pointers) {
        if (isMissing(scope.context, pointer)) missing.add(pointer);
      }

      try {
        const views = new ViewScope();
        const { answer: result } = await this.sandbox.runDSL(
          evaluator,
          views.trapped(rule.condition.value),
          views.trapped(scope.context),
        );
        // The verdict crosses once, through the one reader; it is still read by truthiness (N21).
        if (!readVerdict(result, this.crossing, `condition of ${ruleLabel(rule)}`)) {
          return { reason: 'CONDITION_FALSE', detail: 'condition evaluated to false' };
        }
      } catch (error) {
        if (isRaisedLimit(error)) throw error;
        const cause = error instanceof DSLEvaluationError ? error.originalError : error;
        const detail = clip(cause instanceof Error ? cause.message : String(cause));
        // The text of a plugin's fault is in the record: it is weighed like the rest.
        this.crossing.budget.addText(detail);
        return { reason: 'DSL_ERROR', detail };
      }
    }

    return null;
  }
}
