import { describe, it, expect } from 'vitest';
import { DSLRegistry } from '../../src/registry/DSLRegistry.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';

// R10: the capabilities of a DSL are read once at registration and validated (ruling 18: a strict
// key check: exactDecimals, threeValued, limits).

const dsl = (
  name: string,
  capabilities: unknown,
  extra: Record<string, unknown> = {},
): DSLEvaluator =>
  ({
    dsl: name,
    version: '1.0.0',
    evaluate: () => true,
    capabilities,
    ...extra,
  }) as unknown as DSLEvaluator;

const refusal = (evaluator: DSLEvaluator): string => {
  try {
    new DSLRegistry().register(evaluator);
  } catch (error) {
    return (error as Error).message;
  }
  return 'accepted';
};

describe('R10: DSL capabilities at registration', () => {
  it('t2 and t3 register', () => {
    expect(refusal(dsl('t2', { exactDecimals: false }))).toBe('accepted');
    expect(
      refusal(
        dsl(
          't3',
          { exactDecimals: false, threeValued: true },
          { evaluateTruth: () => ({ value: true }) },
        ),
      ),
    ).toBe('accepted');
    expect(refusal(dsl('plain', undefined))).toBe('accepted');
    expect(
      refusal(
        dsl('lim', { exactDecimals: true, limits: { maxNodes: 1000, maxDepth: 8, maxSteps: 5 } }),
      ),
    ).toBe('accepted');
  });

  it('threeValued by truthiness is refused, naming the field', () => {
    expect(refusal(dsl('t3', { exactDecimals: false, threeValued: 'yes' }))).toBe(
      'DSL evaluator "t3": capabilities.threeValued must be true or false',
    );
    expect(refusal(dsl('t3', { exactDecimals: false, threeValued: 1 }))).toContain(
      'capabilities.threeValued',
    );
  });

  it('exactDecimals must be true or false', () => {
    expect(refusal(dsl('x', { exactDecimals: 1 }))).toBe(
      'DSL evaluator "x": capabilities.exactDecimals must be true or false',
    );
    expect(refusal(dsl('x', {}))).toContain('capabilities.exactDecimals');
  });

  it('an unknown key is refused, naming it', () => {
    expect(refusal(dsl('x', { exactDecimals: false, extra: 1 }))).toBe(
      'DSL evaluator "x": capabilities.extra is not a known capability',
    );
    expect(refusal(dsl('x', { exactDecimals: false, pure: true }))).toContain('capabilities.pure');
  });

  it('a capabilities that is not an object, and limits that are not, are refused', () => {
    expect(refusal(dsl('x', 'fast'))).toContain('capabilities');
    expect(refusal(dsl('x', [true]))).toContain('capabilities');
    expect(refusal(dsl('x', { exactDecimals: false, limits: 5 }))).toBe(
      'DSL evaluator "x": capabilities.limits must be an object',
    );
  });

  it('limits: names as identifiers, positive safe integers, frozen (ruling 5)', () => {
    const bad = (limits: unknown): string => refusal(dsl('x', { exactDecimals: false, limits }));
    expect(bad({ maxNodes: 0 })).toBe(
      'DSL evaluator "x": capabilities.limits.maxNodes must be a positive safe integer',
    );
    expect(bad({ maxNodes: 1.5 })).toContain('capabilities.limits.maxNodes');
    expect(bad({ maxNodes: '5' })).toContain('positive safe integer');
    expect(bad({ maxNodes: 2 ** 60 })).toContain('positive safe integer');
    expect(bad({ 'max-nodes': 5 })).toContain('capabilities.limits.max-nodes is not a valid name');
    expect(bad({ MaxNodes: 5 })).toContain('is not a valid name');
    expect(bad([1])).toContain('capabilities.limits');
    const registry = new DSLRegistry();
    const given = { maxNodes: 5 };
    registry.register(dsl('ok', { exactDecimals: false, limits: given }));
    // the engine's copy is frozen, and the caller's object is not the one kept
    given.maxNodes = 9;
  });

  it('threeValued without evaluateTruth is refused, with the words of the spec', () => {
    expect(refusal(dsl('t3', { exactDecimals: false, threeValued: true }))).toBe(
      'DSL evaluator "t3": evaluateTruth must be a function when capabilities.threeValued is true',
    );
    expect(
      refusal(dsl('t3', { exactDecimals: false, threeValued: true }, { evaluateTruth: 'no' })),
    ).toContain('evaluateTruth must be a function when capabilities.threeValued is true');
  });

  it('an evaluateTruth given without threeValued must still be a function', () => {
    expect(refusal(dsl('t2', { exactDecimals: false }, { evaluateTruth: 5 }))).toBe(
      'DSL evaluator "t2": evaluateTruth must be a function',
    );
  });

  it('capabilities and evaluateTruth are read once: a later change shows nowhere', () => {
    let reads = 0;
    const evaluator = dsl('t3', undefined);
    Object.defineProperty(evaluator, 'capabilities', {
      get() {
        reads += 1;
        return { exactDecimals: false, threeValued: true };
      },
    });
    let truthReads = 0;
    Object.defineProperty(evaluator, 'evaluateTruth', {
      get() {
        truthReads += 1;
        return () => ({ value: true });
      },
    });
    new DSLRegistry().register(evaluator);
    expect(reads).toBe(1);
    expect(truthReads).toBe(1);
  });
});
