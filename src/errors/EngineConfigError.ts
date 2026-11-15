import { PPEError } from './PPEError.js';
import { markEngineError, sealEngineError } from './engineError.js';
import { clipText } from '../utils/weight.js';

const MAX_TEXT = 256;
const MARK = '... [clipped]';

/**
 * The options given to `new PPEEngine` are refused: an unknown key, a value of the wrong type or
 * out of range, a plugin or a DSL that cannot be registered (a duplicate name, a member that is
 * not a function). `path` names the member (`/strict`, `/timeout/hook`, `/plugins/1`), and the
 * reason is the engine's own text. A value is never coerced. The error is frozen at creation.
 */
export class EngineConfigError extends PPEError {
  public readonly path: string;
  public readonly reason: string;

  constructor(path: string, reason: string) {
    // A bad argument is itself a configuration fault, told as such (never a raw TypeError).
    const wellFormed = typeof path === 'string' && typeof reason === 'string';
    const shownPath = wellFormed ? clipText(path, MAX_TEXT, MARK) : '/EngineConfigError/arguments';
    const shownReason = wellFormed
      ? clipText(reason, MAX_TEXT * 4, MARK)
      : 'path and reason must be strings';
    super(`invalid engine configuration at ${shownPath}: ${shownReason}`, 'ENGINE_CONFIG');
    this.name = 'EngineConfigError';
    this.path = shownPath;
    this.reason = shownReason;
    sealEngineError(this, new.target, EngineConfigError);
  }
}

markEngineError(EngineConfigError);
