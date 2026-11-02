import { EngineLimitError } from '../errors/EngineLimitError.js';
import { validateProofInput } from '@run-iq/spec';
import type { ProofInput } from '@run-iq/spec';
import type { EvaluationInput } from '../types/input.js';
import { ValidationError } from '../errors/ValidationError.js';
import { InputCopier, listKeys } from '../input/copyInput.js';
import { describeThrown } from '../utils/values.js';
import { evaluationDate, normalizeMeta } from '../input/normalizeMeta.js';
import type { NormalizedMeta } from '../input/normalizeMeta.js';
import { DEFAULT_LIMITS } from '../limits.js';
import type { EngineLimits } from '../limits.js';

/**
 * The pointers of every `undefined` held in `value` (an object member or a list item, at any
 * depth), without recursion. `value` is the engine's own plain copy.
 */
function undefinedPointers(value: unknown, root: string): string[] {
  const found: string[] = [];
  const stack: { value: unknown; pointer: string }[] = [{ value, pointer: root }];
  while (stack.length > 0) {
    const { value: current, pointer } = stack.pop() as { value: unknown; pointer: string };
    if (typeof current !== 'object' || current === null) continue;
    // A list with holes (refused by the copier, with its own reason) is walked by its items.
    const entries: [string, unknown][] = [];
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (Object.hasOwn(current, index)) entries.push([String(index), current[index]]);
      }
    } else entries.push(...Object.entries(current));
    for (const [key, item] of entries) {
      const at = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (item === undefined) found.push(at);
      else stack.push({ value: item, pointer: at });
    }
  }
  return found.sort();
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The only keys an evaluation input has. */
const INPUT_KEYS: ReadonlySet<string> = new Set(['requestId', 'data', 'meta']);

/** An input that was checked, with the copies the engine goes on with. */
export interface PreparedInput {
  /**
   * The input to evaluate: `data` and each member of `meta` are plain copies made while the
   * input was checked, so that what was checked is what is evaluated. The meta keeps the form it
   * was given (`effectiveDate` as a `Date`, tags in their order).
   */
  readonly input: EvaluationInput;
  /** The canonical meta (`normalizeMeta` of the copy), the one `validateProofInput` checked. */
  readonly meta: NormalizedMeta;
  /** The instant rules are evaluated at, when the input names one (`evaluationDate`). */
  readonly evaluationDate: Date | undefined;
  /** The leaves counted while the input was copied (data and every part of `meta`). */
  readonly leaves: number;
  /** The exact serialized length of the strings and keys of the input: a lower bound of its text. */
  readonly chars: number;
}

/** True for a non-null, non-array object. */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    // A revoked Proxy: not an object the engine can read; it is named, not thrown raw.
    return false;
  }
};

export class InputSanitizer {
  /**
   * Checks an input and makes the plain copy the engine goes on with (`PreparedInput`): its basic
   * shape, then one walk that copies it while holding it to the bounds of `limits`
   * (`EngineLimitError`, `maxInputDepth` and `maxInputLeaves` over the whole input), then the
   * canonical input that `normalizeMeta` writes, checked by `validateProofInput` of
   * `@run-iq/spec` on the copy. Throws `ValidationError` (`Invalid evaluation input`) whose
   * `reasons` are the problems found, in the words of spec for the canonical input
   * (`reserved key /data/$x`, `number beyond 2^53 at /data/a/1`; the pointers are those of the
   * input's digest leaves, `/data/...` and `/meta/...`), and a property that cannot be read
   * (`/data/g could not be read: boom`).
   */
  static prepare(input: unknown, limits: Readonly<EngineLimits> = DEFAULT_LIMITS): PreparedInput {
    const reasons: string[] = [];

    if (input === null || typeof input !== 'object') {
      throw new ValidationError('Input must be a non-null object', ['Input is not an object']);
    }

    const obj = input as Record<string, unknown>;
    // The input is read once: its keys are listed once (a symbol key or a non-enumerable property
    // is named, as it would vanish), then each member once. The checks and the copy below work on
    // these values, whatever a getter or a Proxy would answer to a second read.
    let requestId: unknown;
    let dataIn: unknown;
    let metaIn: unknown;
    try {
      for (const key of listKeys(obj, '', reasons)) {
        if (!INPUT_KEYS.has(key)) reasons.push(`input has an unknown key ${JSON.stringify(key)}`);
      }
      requestId = obj['requestId'];
      dataIn = obj['data'];
      metaIn = obj['meta'];
    } catch (error) {
      throw new ValidationError('Invalid evaluation input', [
        `input could not be read: ${describeThrown(error)}`,
      ]);
    }

    if (typeof requestId !== 'string' || requestId.length === 0) {
      reasons.push('requestId must be a non-empty string');
    } else if (requestId.length > limits.maxStringLength) {
      // The id is text the record holds: held to the same bound as any other text.
      throw new EngineLimitError(
        'maxStringLength',
        limits.maxStringLength,
        requestId.length,
        '/requestId',
      );
    }
    if (!isRecord(dataIn)) reasons.push('data must be a non-null object');

    let meta: Record<string, unknown> | undefined;
    let metaKeys: string[] = [];
    if (!isRecord(metaIn)) {
      reasons.push('meta must be a non-null object');
    } else {
      meta = metaIn;
      try {
        metaKeys = listKeys(meta, '/meta', reasons);
      } catch (error) {
        reasons.push(`/meta could not be read: ${describeThrown(error)}`);
      }
      for (const key of metaKeys) {
        if (FORBIDDEN_KEYS.has(key)) {
          reasons.push(`meta contains forbidden key: "${key}"`);
        }
      }
    }

    if (reasons.length > 0 || meta === undefined || !isRecord(dataIn)) {
      throw new ValidationError('Invalid evaluation input', reasons);
    }

    // The one walk: copy and bounds. Each part of the input is a root at level 1 and they share
    // the count of leaves; a too large input is refused before spec reads it.
    const copier = new InputCopier(limits);
    // justification: `copy` of a plain object returns a plain object (`dataIn` is a record).
    const data = copier.copy(dataIn, '/data') as Record<string, unknown>;
    // The forbidden keys are looked for on the copy: the keys that are evaluated are the ones
    // that are checked.
    for (const key of Object.keys(data)) {
      if (FORBIDDEN_KEYS.has(key)) reasons.push(`data contains forbidden key: "${key}"`);
    }
    // defineProperty: an own `__proto__` key stays a member of the copy and cannot set its
    // prototype. The keys are the ones listed above, once.
    const metaCopy: Record<string, unknown> = {};
    for (const key of metaKeys) {
      // Each key of `meta` is a node, as the keys of any object are.
      copier.node();
      let member: unknown;
      try {
        member = meta[key];
      } catch (error) {
        copier.unreadable(`/meta/${key}`, error);
        continue;
      }
      Object.defineProperty(metaCopy, key, {
        value: copier.copy(member, `/meta/${key}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    // The tenant is checked on the copy: it is the one that is recorded.
    const tenantId: unknown = metaCopy['tenantId'];
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      reasons.push('meta.tenantId must be a non-empty string');
    }
    // An empty `dimensions` declares nothing, like no `dimensions`, and the canonical form cannot
    // tell them apart: the engine never guesses, so the caller omits it.
    const declared: unknown = metaCopy['dimensions'];
    if (isRecord(declared) && Object.keys(declared).length === 0) {
      reasons.push('/meta/dimensions is empty: omit it to declare no dimensions');
    }
    // `undefined` is not a JSON value. In `dimensions`, `dates` and `assertions` the canonical form
    // would drop a key that holds it (or write `null` for a list item), and an input that declares
    // a dimension would then decide like one that declares none: it is refused, anywhere in them,
    // with its pointer, like any other value that is not JSON. (A member of `meta` that is itself
    // `undefined` is absent, as for spec.)
    for (const part of ['dimensions', 'dates', 'assertions'] as const) {
      for (const pointer of undefinedPointers(metaCopy[part], `/meta/${part}`)) {
        reasons.push(`${pointer} is not JSON: undefined`);
      }
    }
    if (copier.reasons.length > 0 || reasons.length > 0) {
      throw new ValidationError('Invalid evaluation input', [...reasons, ...copier.reasons]);
    }
    Object.freeze(metaCopy);

    let canonical: NormalizedMeta | undefined;
    try {
      // `metaCopy` is a plain copy of unchecked members: `normalizeMeta` and then
      // `validateProofInput` check them, so the type is not true yet.
      canonical = normalizeMeta(metaCopy as unknown as EvaluationInput['meta']);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      reasons.push(...error.reasons);
    }
    if (canonical !== undefined) {
      const checked: ProofInput = { data: data as ProofInput['data'], meta: canonical };
      for (const issue of validateProofInput(checked)) reasons.push(issue.message);
    }
    if (reasons.length > 0 || canonical === undefined) {
      throw new ValidationError('Invalid evaluation input', reasons);
    }

    return {
      input: Object.freeze({
        requestId: requestId as string,
        data,
        // justification: `validateProofInput` accepted the canonical form of these members.
        meta: metaCopy as unknown as EvaluationInput['meta'],
      }),
      meta: canonical,
      evaluationDate: evaluationDate(canonical),
      leaves: copier.leaves,
      chars: copier.chars,
    };
  }

  /** `prepare`, for a caller that only wants the check. */
  static validate(
    input: unknown,
    limits: Readonly<EngineLimits> = DEFAULT_LIMITS,
  ): asserts input is EvaluationInput {
    InputSanitizer.prepare(input, limits);
  }
}
