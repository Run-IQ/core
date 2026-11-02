import { validateProofInput } from '@run-iq/spec';
import type { ProofInput } from '@run-iq/spec';
import type { EvaluationInput } from '../types/input.js';
import { ValidationError } from '../errors/ValidationError.js';
import { InputCopier } from '../input/copyInput.js';
import { evaluationDate, normalizeMeta } from '../input/normalizeMeta.js';
import type { NormalizedMeta } from '../input/normalizeMeta.js';
import { DEFAULT_LIMITS } from '../limits.js';
import type { EngineLimits } from '../limits.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
}

/** True for a non-null, non-array object. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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
    // Each member of the input is read once, here: the checks and the copy below work on these
    // values, whatever a getter or a Proxy would answer to a second read.
    const requestId: unknown = obj['requestId'];
    const dataIn: unknown = obj['data'];
    const metaIn: unknown = obj['meta'];

    if (typeof requestId !== 'string' || requestId.length === 0) {
      reasons.push('requestId must be a non-empty string');
    }

    if (!isRecord(dataIn)) {
      reasons.push('data must be a non-null object');
    } else {
      for (const key of Object.keys(dataIn)) {
        if (FORBIDDEN_KEYS.has(key)) {
          reasons.push(`data contains forbidden key: "${key}"`);
        }
      }
    }

    let meta: Record<string, unknown> | undefined;
    let metaKeys: string[] = [];
    if (!isRecord(metaIn)) {
      reasons.push('meta must be a non-null object');
    } else {
      meta = metaIn;
      metaKeys = Object.keys(meta);
      if (typeof meta['tenantId'] !== 'string' || meta['tenantId'].length === 0) {
        reasons.push('meta.tenantId must be a non-empty string');
      }
      for (const key of metaKeys) {
        if (FORBIDDEN_KEYS.has(key)) {
          reasons.push(`meta contains forbidden key: "${key}"`);
        }
      }
    }

    if (reasons.length > 0 || meta === undefined) {
      throw new ValidationError('Invalid evaluation input', reasons);
    }

    // The one walk: copy and bounds. Each part of the input is a root at level 1 and they share
    // the count of leaves; a too large input is refused before spec reads it.
    const copier = new InputCopier(limits);
    const data = copier.copy(dataIn, '/data') as Record<string, unknown>;
    // defineProperty: an own `__proto__` key stays a member of the copy and cannot set its
    // prototype. The keys are the ones listed above, once.
    const metaCopy: Record<string, unknown> = {};
    for (const key of metaKeys) {
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
    if (copier.reasons.length > 0) {
      throw new ValidationError('Invalid evaluation input', copier.reasons);
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
