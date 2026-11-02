import { PPEError } from './PPEError.js';
import { describeThrown } from '../utils/values.js';

/**
 * A plugin hook failed, so the evaluation fails (fail closed): a decision is never returned when
 * it was computed without the preparation a plugin was supposed to do. Thrown for a hook that
 * throws or times out (`HookTimeoutError` is then the `cause`), that returns a malformed value,
 * whose returned input is refused (bounds, `validateProofInput`, strict mode), or whose effect the
 * engine would have to refuse, discard or correct (rules removed without a skip, a state that is
 * not JSON, engine-owned fields changed). `onError` is called on every plugin, nothing is saved.
 */
export class PluginHookError extends PPEError {
  constructor(
    public readonly plugin: string,
    public readonly hook: 'beforeEvaluate' | 'afterEvaluate',
    /** The error the hook threw, or the error describing what was refused. */
    public override readonly cause: unknown,
  ) {
    super(`plugin ${plugin} ${hook} failed: ${describeThrown(cause)}`, 'PLUGIN_HOOK');
    this.name = 'PluginHookError';
  }
}
