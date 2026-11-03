import { ValidationError } from './errors/ValidationError.js';

/**
 * The bounds of one evaluation (D-26). Passing one throws `EngineLimitError`. In 9L, `maxRules`,
 * `maxInputLeaves`, `maxInputDepth`, `maxStringLength`, `maxRuleLeaves`, `maxHookLeaves`,
 * `maxRuleSetNodes`, `maxTraceNodes` and `maxRecordLength` are enforced; the others are held here
 * for the tasks that need them (collections, strata, segments, recursion, referentials, groups),
 * and nothing reads them yet.
 *
 * The size limits count **nodes**: each key of an object, each element of a list and each scalar
 * (a list and an empty object count one too). An object of 1 000 keys with a scalar each is 2 000
 * nodes. Their names say "leaves" for historical reasons (D-15).
 */
export interface EngineLimits {
  /** Rules given to one `evaluate`. */
  maxRules: number;
  /** Instances of rules over the elements of collections. */
  maxInstances: number;
  /** Elements of one collection. */
  maxCollectionLength: number;
  /** Nodes of the input tree (D-15), on every path: keys, elements, scalars, lists, empty objects. */
  maxInputLeaves: number;
  /**
   * Levels of containers with members, in `data` and in each member of `meta` (`context`, `tags`,
   * `dates`, `dimensions`, `assertions`): the container at the root of a part is level 1, and an
   * empty container adds no level, as in `validateProofInput`.
   */
  maxInputDepth: number;
  /** Evaluation strata. */
  maxStrata: number;
  /** Segments of a segmented collection. */
  maxSegments: number;
  /** Depth of a recursive collection walk. */
  maxRecursionDepth: number;
  /** Nodes walked in a referential. */
  maxReferentialNodes: number;
  /** Nesting of groups in a referential. */
  maxGroupDepth: number;
  /**
   * Nodes of one rule, counted as for the input: a rule the engine reads, whether given by the
   * caller, returned by a hook, or held in a skip; and one value a model returns.
   */
  maxRuleLeaves: number;
  /**
   * Nodes read, in total, from everything plugin code hands the engine in one evaluation: the
   * returns of all the hooks (rules, skips and their details, state, and the input each hook
   * returns), the outputs of the models, and the text of the results of `validateParams`, of the
   * verdicts of the DSLs and of the answers of `listVariables`. Plugin code cannot make the engine
   * read more, however many times it repeats a value or how big it is, and three hooks cannot read
   * three times as much.
   */
  maxHookLeaves: number;
  /**
   * Nodes of all the rules of one evaluation given by the caller, together: so that
   * `maxRules` rules of `maxRuleLeaves` nodes each cannot break the budget of the evaluation.
   */
  maxRuleSetNodes: number;
  /**
   * Characters (UTF-16 code units) of one string, key or text value, in the input, in a rule and in
   * what a hook or a model returns. A longer one is refused with its pointer. The characters read
   * also count against the node bounds, one node per 64 characters, **each time they are read**:
   * a string shared by many rules costs what it weighs in each of them.
   */
  maxStringLength: number;
  /**
   * Characters of the serialized record of one evaluation (what is saved and checksummed). The
   * record holds the input, the rules, the result and the trace, each rule more than once: the
   * node bounds do not see how often a shared value is written, this one does. Past it (or where
   * the runtime cannot build a string that long) the evaluation fails with `EngineLimitError`;
   * nothing is saved.
   */
  maxRecordLength: number;
  /**
   * Nodes of the input times the number of steps of the trace. Each step records the input it
   * was computed on and the record writes it every time, so the cost of the trace is this product,
   * which neither `maxInputLeaves` nor `maxRules` holds. Past it, the evaluation is refused after
   * the rules are computed and before the record is built. An input of `maxInputLeaves` nodes is
   * reachable with up to twenty applied rules (500 000 times 20 is 10 000 000); with more rules
   * this bound decides before the input bound does.
   */
  maxTraceNodes: number;
}

/**
 * The defaults, lowered and completed by the pre-flight (I20, I30). In 9L, `maxRules`,
 * `maxInputLeaves`, `maxRuleLeaves`, `maxHookLeaves`, `maxRuleSetNodes`, `maxTraceNodes` and
 * `maxStringLength` are held by a scale test at their value, with a written budget, on the
 * costliest shape (wide objects) (D-26), and all of them together by the worst-case test, each
 * with at least a quarter of its budget to spare; `maxInputDepth` is enforced and tested at its
 * value, without a budget. The seven others are inert: the tasks that enforce them add their scale test (9H1, 9K1 and 9R1 per D-26).
 */
export const DEFAULT_LIMITS: Readonly<EngineLimits> = Object.freeze({
  maxRules: 100_000,
  maxInstances: 250_000,
  maxCollectionLength: 250_000,
  maxInputLeaves: 500_000,
  maxInputDepth: 128,
  maxStrata: 1_000,
  maxSegments: 10_000,
  maxRecursionDepth: 256,
  maxReferentialNodes: 100_000,
  maxGroupDepth: 64,
  maxRuleLeaves: 100_000,
  maxHookLeaves: 400_000,
  maxRuleSetNodes: 2_000_000,
  maxStringLength: 1_000_000,
  maxRecordLength: 256_000_000,
  maxTraceNodes: 10_000_000,
});

/** The limits a caller may give: any of them, or `undefined` for the default. */
export type EngineLimitsInput = { readonly [K in keyof EngineLimits]?: number | undefined };

/** `validateProofInput` of `@run-iq/spec` stops at 1000 levels: no limit may allow more. */
const MAX_INPUT_DEPTH_CEILING = 1000;

/**
 * The limits an engine runs with: `DEFAULT_LIMITS` with the members of `given` that are not
 * `undefined`. Throws `ValidationError` (`Invalid limits`) listing every unknown key and every
 * value that is not a positive safe integer, and a `maxInputDepth` above 1000.
 */
export function resolveLimits(given?: EngineLimitsInput): Readonly<EngineLimits> {
  if (given === undefined) return DEFAULT_LIMITS;
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new ValidationError('Invalid limits', ['limits must be an object']);
  }
  const reasons: string[] = [];
  const out: EngineLimits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(given)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      reasons.push(`unknown limit: ${key}`);
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      reasons.push(`limits.${key} must be a positive integer`);
      continue;
    }
    if (key === 'maxInputDepth' && value > MAX_INPUT_DEPTH_CEILING) {
      reasons.push(`limits.maxInputDepth must be at most ${MAX_INPUT_DEPTH_CEILING}`);
      continue;
    }
    out[key as keyof EngineLimits] = value;
  }
  if (reasons.length > 0) throw new ValidationError('Invalid limits', reasons);
  return out;
}
