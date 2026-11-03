import { describe, it, expect } from 'vitest';
import { PluginHookError } from '../../src/errors/PluginHookError.js';
import { HookTimeoutError } from '../../src/errors/HookTimeoutError.js';
import { PPEError } from '../../src/errors/PPEError.js';

describe('PluginHookError', () => {
  it('names the plugin, the hook and the cause, and keeps a frozen copy of the cause as it was thrown', () => {
    const cause = new RangeError('too big');
    const error = new PluginHookError('fiscal', 'beforeEvaluate', cause);
    expect(error).toBeInstanceOf(PPEError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'PluginHookError',
      code: 'PLUGIN_HOOK',
      plugin: 'fiscal',
      hook: 'beforeEvaluate',
      message: 'plugin fiscal beforeEvaluate failed: too big',
    });
    expect(error.cause).not.toBe(cause);
    expect(error.cause).toMatchObject({ name: 'RangeError' });
    expect((error.cause as Error).message).toBe('too big');
    expect(Object.isFrozen(error.cause)).toBe(true);
  });

  it('keeps a HookTimeoutError as its cause', () => {
    const cause = new HookTimeoutError('slow', 'afterEvaluate', 50);
    const error = new PluginHookError('slow', 'afterEvaluate', cause);
    expect(error.cause).not.toBe(cause);
    expect(error.cause).toBeInstanceOf(HookTimeoutError);
    expect((error.cause as Error).message).toBe(cause.message);
    expect(error.hook).toBe('afterEvaluate');
    expect(error.message).toBe(
      'plugin slow afterEvaluate failed: plugin slow hook afterEvaluate timed out after 50 ms',
    );
  });

  it('writes a cause that is not an error as text, and keeps it', () => {
    const error = new PluginHookError('p', 'afterEvaluate', 'plain text');
    expect(error.message).toBe('plugin p afterEvaluate failed: plain text');
    expect(error.cause).toEqual({ name: 'Error', message: 'plain text' });
    const object = { code: 1 };
    const copy = new PluginHookError('p', 'afterEvaluate', object).cause;
    expect(copy).toEqual({ name: 'Error', message: '' });
    expect(copy).not.toBe(object);
    expect(Object.isFrozen(copy)).toBe(true);
  });
});
