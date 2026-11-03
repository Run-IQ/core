import { PPEError } from './PPEError.js';
import { describeThrown } from '../utils/values.js';
import { clip, frozenErrorCopy } from '../utils/frozenCopy.js';
import { describeFault, trustedFault } from '../engine/pluginPort.js';
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
    // What the plugin threw is held as text, read once (see `faultOf`); an error the engine raised
    // while checking what the plugin returned is copied. The message is built from what is kept.
    const fault = trustedFault(cause);
    super(
      `plugin ${plugin} ${hook} failed: ${fault === undefined ? clip(describeThrown(cause)) : describeFault(fault)}`,
      'PLUGIN_HOOK',
    );
    this.name = 'PluginHookError';
    this.cause = fault === undefined ? frozenErrorCopy(cause) : Object.freeze({ ...fault });
  }

  /** The error the hook threw (a frozen copy of it), or the error describing what was refused. */
  declare readonly cause: unknown;
}

markEngineError(PluginHookError);
