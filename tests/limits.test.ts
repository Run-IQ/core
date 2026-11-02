import { describe, it, expect } from 'vitest';
import { DEFAULT_LIMITS, resolveLimits } from '../src/limits.js';
import { EngineLimitError } from '../src/errors/EngineLimitError.js';
import { ValidationError } from '../src/errors/ValidationError.js';
import { PPEError } from '../src/errors/PPEError.js';

const refusal = (limits: unknown): ValidationError => {
  try {
    resolveLimits(limits as never);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  return expect.unreachable('should have thrown');
};

describe('DEFAULT_LIMITS', () => {
  it('holds the values of the plan, frozen', () => {
    expect(DEFAULT_LIMITS).toEqual({
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
      maxHookLeaves: 8_000_000,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });
});

describe('resolveLimits', () => {
  it('gives the defaults for nothing, and overrides only what is named', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits({ maxRules: 3, maxInputDepth: 1000 })).toEqual({
      ...DEFAULT_LIMITS,
      maxRules: 3,
      maxInputDepth: 1000,
    });
    expect(resolveLimits({ maxRules: undefined })).toEqual(DEFAULT_LIMITS);
  });

  it('refuses a zero, a negative, a fraction and a non-number, each named', () => {
    expect(refusal({ maxRules: 0 }).reasons).toEqual([
      'limits.maxRules must be a positive integer',
    ]);
    expect(refusal({ maxRules: -1, maxInstances: 1.5, maxStrata: '3' }).reasons).toEqual([
      'limits.maxRules must be a positive integer',
      'limits.maxInstances must be a positive integer',
      'limits.maxStrata must be a positive integer',
    ]);
    expect(refusal({ maxRules: Infinity }).reasons).toEqual([
      'limits.maxRules must be a positive integer',
    ]);
    // A number past 2^53 - 1 is not an integer a count can be exact in.
    expect(refusal({ maxRules: 2 ** 53 }).reasons).toEqual([
      'limits.maxRules must be a positive integer',
    ]);
    expect(resolveLimits({ maxRules: 2 ** 53 - 1 }).maxRules).toBe(2 ** 53 - 1);
  });

  it('refuses an unknown key', () => {
    const error = refusal({ maxRulez: 3 });
    expect(error.message).toBe('Invalid limits');
    expect(error.reasons).toEqual(['unknown limit: maxRulez']);
  });

  it('refuses maxInputDepth past 1000, the limit of validateProofInput', () => {
    expect(resolveLimits({ maxInputDepth: 1000 }).maxInputDepth).toBe(1000);
    expect(refusal({ maxInputDepth: 1001 }).reasons).toEqual([
      'limits.maxInputDepth must be at most 1000',
    ]);
  });

  it('refuses anything but an object', () => {
    for (const bad of [null, 3, 'x', []]) {
      expect(refusal(bad).reasons).toEqual(['limits must be an object']);
    }
  });
});

describe('EngineLimitError', () => {
  it('names the limit, the maximum and the actual value', () => {
    const error = new EngineLimitError('maxRules', 3, 4);
    expect(error).toBeInstanceOf(PPEError);
    expect(error).toMatchObject({
      name: 'EngineLimitError',
      code: 'ENGINE_LIMIT',
      limit: 'maxRules',
      max: 3,
      actual: 4,
      message: 'engine limit maxRules exceeded: 4 > 3',
    });
  });
});
