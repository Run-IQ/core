import { validateProofInput } from '@run-iq/spec';
import type { ProofInput } from '@run-iq/spec';
import type { EvaluationInput } from '../types/input.js';
import { ValidationError } from '../errors/ValidationError.js';
import { EngineLimitError } from '../errors/EngineLimitError.js';
import { normalizeMeta } from '../input/normalizeMeta.js';
import { DEFAULT_LIMITS } from '../limits.js';
import type { EngineLimits } from '../limits.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Walks `root` without recursion and holds it to the bounds of the input: at most
 * `maxInputDepth` levels of containers (`root` is the first) and `maxInputLeaves` leaves in all,
 * counted as the input tree counts them (D-15): each scalar, each list and each empty object,
 * on every path (an object met twice is counted twice). The walk stops at the first value past a
 * bound, so its cost is bounded by the bound, not by the input: `actual` is that first value
 * (`max + 1`). A property that cannot be read counts as a leaf: `validateProofInput` names it.
 */
function measure(root: unknown, limits: EngineLimits, counted: { leaves: number }): void {
  const leaf = (): void => {
    counted.leaves += 1;
    if (counted.leaves > limits.maxInputLeaves) {
      throw new EngineLimitError('maxInputLeaves', limits.maxInputLeaves, counted.leaves);
    }
  };
  interface Frame {
    readonly node: object;
    readonly keys: readonly string[] | undefined;
    readonly length: number;
    index: number;
  }
  const open = (value: unknown, depth: number): Frame | undefined => {
    if (value === null || typeof value !== 'object') {
      leaf();
      return undefined;
    }
    let keys: readonly string[] | undefined;
    let length: number;
    try {
      if (Array.isArray(value)) {
        length = value.length;
        leaf(); // a list is a leaf, and so are its elements
      } else {
        keys = Object.keys(value);
        length = keys.length;
        if (length === 0) leaf(); // an empty object is a leaf
      }
    } catch (error) {
      if (error instanceof EngineLimitError) throw error;
      leaf();
      return undefined;
    }
    if (length === 0) return undefined;
    if (depth > limits.maxInputDepth) {
      throw new EngineLimitError('maxInputDepth', limits.maxInputDepth, depth);
    }
    return { node: value, keys, length, index: 0 };
  };

  const stack: Frame[] = [];
  const first = open(root, 1);
  if (first !== undefined) stack.push(first);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.index >= frame.length) {
      stack.pop();
      continue;
    }
    const i = frame.index++;
    let member: unknown;
    try {
      member =
        frame.keys === undefined
          ? (frame.node as unknown[])[i]
          : (frame.node as Record<string, unknown>)[frame.keys[i] as string];
    } catch {
      leaf();
      continue;
    }
    const child = open(member, stack.length + 1);
    if (child !== undefined) stack.push(child);
  }
}

export class InputSanitizer {
  /**
   * Checks an input without keeping a copy: its basic shape, then the bounds of `limits`
   * (`EngineLimitError`, `maxInputDepth` and `maxInputLeaves`), then the canonical input that
   * `normalizeMeta` writes, with `validateProofInput` of `@run-iq/spec`. Throws `ValidationError`
   * (`Invalid evaluation input`) whose `reasons` are the problems found, in the words of spec
   * for the canonical input (`reserved key /data/$x`, `number beyond 2^53 at /data/a/1`).
   */
  static validate(
    input: unknown,
    limits: EngineLimits = DEFAULT_LIMITS,
  ): asserts input is EvaluationInput {
    const reasons: string[] = [];

    if (input === null || typeof input !== 'object') {
      throw new ValidationError('Input must be a non-null object', ['Input is not an object']);
    }

    const obj = input as Record<string, unknown>;

    if (typeof obj['requestId'] !== 'string' || obj['requestId'].length === 0) {
      reasons.push('requestId must be a non-empty string');
    }

    if (obj['data'] === null || typeof obj['data'] !== 'object' || Array.isArray(obj['data'])) {
      reasons.push('data must be a non-null object');
    } else {
      const dataKeys = Object.keys(obj['data'] as Record<string, unknown>);
      for (const key of dataKeys) {
        if (FORBIDDEN_KEYS.has(key)) {
          reasons.push(`data contains forbidden key: "${key}"`);
        }
      }
    }

    let meta: Record<string, unknown> | undefined;
    if (obj['meta'] === null || typeof obj['meta'] !== 'object' || Array.isArray(obj['meta'])) {
      reasons.push('meta must be a non-null object');
    } else {
      meta = obj['meta'] as Record<string, unknown>;
      if (typeof meta['tenantId'] !== 'string' || meta['tenantId'].length === 0) {
        reasons.push('meta.tenantId must be a non-empty string');
      }
      const metaKeys = Object.keys(meta);
      for (const key of metaKeys) {
        if (FORBIDDEN_KEYS.has(key)) {
          reasons.push(`meta contains forbidden key: "${key}"`);
        }
      }
    }

    if (reasons.length > 0 || meta === undefined) {
      throw new ValidationError('Invalid evaluation input', reasons);
    }

    // The bounds first: a too large input is refused before the spec check reads it all.
    const counted = { leaves: 0 };
    measure(obj['data'], limits, counted);
    for (const part of ['context', 'tags', 'dates', 'dimensions', 'assertions']) {
      if (meta[part] !== undefined) measure(meta[part], limits, counted);
    }

    const canonical = InputSanitizer.canonical(obj as unknown as EvaluationInput, reasons);
    if (canonical !== undefined) {
      for (const issue of validateProofInput(canonical)) reasons.push(issue.message);
    }
    if (reasons.length > 0) throw new ValidationError('Invalid evaluation input', reasons);
  }

  /**
   * The canonical input of `input` (`data` as given, `meta` by `normalizeMeta`), for
   * `validateProofInput`. When `normalizeMeta` refuses, its reasons go to `reasons` and the
   * result is `undefined`.
   */
  private static canonical(input: EvaluationInput, reasons: string[]): ProofInput | undefined {
    try {
      return { data: input.data as ProofInput['data'], meta: normalizeMeta(input.meta) };
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      reasons.push(...error.reasons);
      return undefined;
    }
  }
}
