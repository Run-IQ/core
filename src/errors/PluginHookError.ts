import { PPEError } from './PPEError.js';
import { describeThrown } from '../utils/values.js';
import { frozenErrorCopy } from '../utils/frozenCopy.js';
import { markEngineError } from './engineError.js';

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
    public readonly hook: 'onInit' | 'beforeEvaluate' | 'afterEvaluate',
    cause: unknown,
  ) {
    super(`plugin ${plugin} ${hook} failed: ${describeThrown(cause)}`, 'PLUGIN_HOOK');
    this.name = 'PluginHookError';
    // What the hook threw is captured once, as a deep-frozen copy: the object the plugin holds is
    // never handed on, so nothing it does afterwards changes the failure the caller reads.
    this.cause = frozenErrorCopy(cause);
  }

  /** The error the hook threw (a frozen copy of it), or the error describing what was refused. */
  declare readonly cause: unknown;
}

markEngineError(PluginHookError);
