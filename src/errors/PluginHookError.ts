import { PPEError } from './PPEError.js';
import { describeThrown } from '../utils/values.js';
import { clip, frozenErrorCopy } from '../utils/frozenCopy.js';
import { describeFault, faultOf, trustedFault } from '../engine/pluginPort.js';
import { EngineLimitError } from './EngineLimitError.js';
import { markEngineError } from './engineError.js';

/** Every hook of a plugin. */
export type HookName = 'onInit' | 'beforeEvaluate' | 'afterEvaluate' | 'onError';

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
    public readonly hook: HookName,
    cause: unknown,
  ) {
    // What the plugin threw is held as text, read once (see `faultOf`). So is a limit passed while
    // reading what the plugin returned (the plugin's return is the fault: the text names the limit,
    // its maximum and the pointer) and any refusal of the engine's internal classes, which never
    // leave the engine. An error of a public class that the engine raised (a `ValidationError` for
    // an input a hook returned, a `HookTimeoutError`) is copied, frozen. The message is built from
    // what is kept.
    const publicError = cause instanceof PPEError && !(cause instanceof EngineLimitError);
    const fault = publicError ? undefined : (trustedFault(cause) ?? faultOf(cause));
    super(
      `plugin ${plugin} ${hook} failed: ${fault === undefined ? clip(describeThrown(cause)) : describeFault(fault)}`,
      'PLUGIN_HOOK',
    );
    this.name = 'PluginHookError';
    this.cause = fault === undefined ? frozenErrorCopy(cause) : Object.freeze({ ...fault });
  }

  /** The text of the fault, or a frozen copy of the public error the engine raised. */
  declare readonly cause: unknown;
}

markEngineError(PluginHookError);
