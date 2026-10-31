import { describe, it, expect } from 'vitest';
import { PluginSandbox } from '../../src/security/PluginSandbox.js';
import { DSLTimeoutError } from '../../src/errors/DSLTimeoutError.js';
import { HookTimeoutError } from '../../src/errors/HookTimeoutError.js';
import { DSLEvaluationError } from '../../src/errors/DSLEvaluationError.js';
import { StubDSL } from '../helpers.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';

describe('PluginSandbox', () => {
  it('runs a hook and returns result', async () => {
    const sandbox = new PluginSandbox(500, 100);
    const result = await sandbox.runHook(() => 42, 'test', 'beforeEvaluate');
    expect(result).toBe(42);
  });

  it('times out a slow hook with a HookTimeoutError naming the plugin and hook', async () => {
    const sandbox = new PluginSandbox(20, 100);
    const slow = sandbox.runHook(
      () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 200)),
      'fiscal',
      'afterEvaluate',
    );
    await expect(slow).rejects.toThrow(HookTimeoutError);
    await expect(slow).rejects.toThrow('plugin fiscal hook afterEvaluate timed out after 20 ms');
  });

  it('runs a DSL evaluation and returns boolean', async () => {
    const sandbox = new PluginSandbox(500, 100);
    const dsl = new StubDSL('test', true);
    const result = await sandbox.runDSL(dsl, {}, {});
    expect(result).toBe(true);
  });

  it('throws DSLEvaluationError for non-timeout DSL errors', async () => {
    const sandbox = new PluginSandbox(500, 100);
    const throwingDSL: DSLEvaluator = {
      dsl: 'bad',
      version: '1.0.0',
      evaluate: () => {
        throw new Error('syntax error in expression');
      },
    };
    await expect(sandbox.runDSL(throwingDSL, {}, {})).rejects.toThrow(DSLEvaluationError);
    await expect(sandbox.runDSL(throwingDSL, {}, {})).rejects.not.toThrow(DSLTimeoutError);
  });

  it('catches errors from hooks', async () => {
    const sandbox = new PluginSandbox(500, 100);
    await expect(
      sandbox.runHook(
        () => {
          throw new Error('hook error');
        },
        'test',
        'afterEvaluate',
      ),
    ).rejects.toThrow('hook error');
  });

  it('times out async DSL that exceeds timeout', async () => {
    const sandbox = new PluginSandbox(500, 50);
    const slowDSL: DSLEvaluator = {
      dsl: 'slow',
      version: '1.0.0',
      evaluate: () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(true), 200);
        }),
    };
    await expect(sandbox.runDSL(slowDSL, {}, {})).rejects.toThrow(DSLTimeoutError);
  });
});
