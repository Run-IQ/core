import { describe, it, expect } from 'vitest';
import { DSLNotFoundError, PPEError } from '../../src/errors/index.js';

describe('DSLNotFoundError', () => {
  it('extends PPEError', () => {
    const error = new DSLNotFoundError('jsonlogic');
    expect(error).toBeInstanceOf(PPEError);
    expect(error).toBeInstanceOf(Error);
  });

  it('stores the dslName property', () => {
    const error = new DSLNotFoundError('cel');
    expect(error.dslName).toBe('cel');
  });

  it('sets the error name to DSLNotFoundError', () => {
    const error = new DSLNotFoundError('jsonlogic');
    expect(error.name).toBe('DSLNotFoundError');
  });

  it('sets the error code to DSL_NOT_FOUND', () => {
    const error = new DSLNotFoundError('jsonlogic');
    expect(error.code).toBe('DSL_NOT_FOUND');
  });

  it('includes dsl name in the error message', () => {
    const error = new DSLNotFoundError('unknown-dsl');
    expect(error.message).toBe('DSL evaluator "unknown-dsl" not found in DSLRegistry');
  });

  it('works with different dsl names', () => {
    const error = new DSLNotFoundError('expr');
    expect(error.dslName).toBe('expr');
    expect(error.message).toContain('expr');
  });
});
