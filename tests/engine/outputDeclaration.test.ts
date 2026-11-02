import { describe, expect, it } from 'vitest';
import type { OutputDeclaration } from '@run-iq/spec';
import { declarationKey, describeDeclaration } from '../../src/engine/outputDeclaration.js';

const decimal = (rounding: OutputDeclaration['rounding']): OutputDeclaration => ({
  type: 'decimal',
  combine: 'sum',
  ...(rounding === undefined ? {} : { rounding }),
});

describe('declarationKey: the normal form of the spec', () => {
  it('writes a scale rounding with its mode, and no default at', () => {
    expect(declarationKey(decimal({ scale: 2, mode: 'halfUp' }))).toBe(
      '{"combine":"sum","rounding":{"mode":"halfUp","scale":2},"type":"decimal"}',
    );
    expect(declarationKey(decimal({ scale: 2, mode: 'halfUp', at: 'output' }))).toBe(
      '{"combine":"sum","rounding":{"mode":"halfUp","scale":2},"type":"decimal"}',
    );
  });

  it('keeps at: contribution', () => {
    expect(declarationKey(decimal({ scale: 2, mode: 'halfUp', at: 'contribution' }))).toBe(
      '{"combine":"sum","rounding":{"at":"contribution","mode":"halfUp","scale":2},"type":"decimal"}',
    );
  });

  it('writes an increment that is a power of ten as its scale', () => {
    const asScale = declarationKey(decimal({ scale: 2, mode: 'halfUp' }));
    expect(declarationKey(decimal({ increment: '0.01', mode: 'halfUp' }))).toBe(asScale);
    expect(declarationKey(decimal({ increment: '1', mode: 'halfUp' }))).toBe(
      '{"combine":"sum","rounding":{"mode":"halfUp","scale":0},"type":"decimal"}',
    );
  });

  it('keeps any other increment, with its at dropped when it is output', () => {
    expect(declarationKey(decimal({ increment: '0.05', mode: 'halfEven' }))).toBe(
      '{"combine":"sum","rounding":{"increment":"0.05","mode":"halfEven"},"type":"decimal"}',
    );
    expect(declarationKey(decimal({ increment: '0.05', mode: 'halfEven', at: 'output' }))).toBe(
      '{"combine":"sum","rounding":{"increment":"0.05","mode":"halfEven"},"type":"decimal"}',
    );
    expect(declarationKey(decimal({ increment: '0.05', mode: 'halfEven' }))).not.toBe(
      declarationKey(decimal({ increment: '0.5', mode: 'halfEven' })),
    );
  });

  it('drops empty: false, as the spec writes it', () => {
    expect(declarationKey({ type: 'boolean', combine: 'all', empty: false })).toBe(
      declarationKey({ type: 'boolean', combine: 'all' }),
    );
  });
});

describe('describeDeclaration', () => {
  it('names a scale, an increment and where the rounding applies', () => {
    expect(describeDeclaration(decimal({ scale: 2, mode: 'halfUp', at: 'contribution' }))).toBe(
      'decimal/sum rounding 2 halfUp at contribution',
    );
    expect(describeDeclaration(decimal({ increment: '0.05', mode: 'halfUp' }))).toBe(
      'decimal/sum rounding increment 0.05 halfUp',
    );
  });

  it('describes what round does: the scale when both steps are set, nothing without a step', () => {
    // Spec refuses both, but `round` takes the scale first: the message says what is done.
    expect(
      describeDeclaration(decimal({ scale: 2, increment: '0.05', mode: 'halfUp', at: 'output' })),
    ).toBe('decimal/sum rounding 2 halfUp at output');
    expect(describeDeclaration(decimal({ mode: 'halfUp', at: 'contribution' }))).toBe(
      'decimal/sum',
    );
  });
});
