import { ValidationError } from './errors/ValidationError.js';

/**
 * The bounds of one evaluation (D-26). Passing one throws `EngineLimitError`. In 9L, `maxRules`,
 * `maxInputLeaves` and `maxInputDepth` are enforced; the others are held here for the tasks that
 * need them (collections, strata, segments, recursion, referentials, groups), and nothing reads
 * them yet.
 */
export interface EngineLimits {
  /** Rules given to one `evaluate`. */
  maxRules: number;
  /** Instances of rules over the elements of collections. */
  maxInstances: number;
  /** Elements of one collection. */
  maxCollectionLength: number;
  /** Leaves of the input tree (D-15): scalars, lists and empty objects, on every path. */
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
}

/**
 * The defaults, lowered and completed by the pre-flight (I20, I30). In 9L, `maxRules` and
 * `maxInputLeaves` are held by a scale test at their value, with a written budget (D-26);
 * `maxInputDepth` is enforced and tested at its value, without a budget. The seven others are
 * inert: the tasks that enforce them add their scale test (9H1, 9K1 and 9R1 per D-26).
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
