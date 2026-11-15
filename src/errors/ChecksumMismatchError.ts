import { PPEError } from './PPEError.js';
import { optStr, str } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';
import { clipText } from '../utils/weight.js';

/**
 * A rule's checksum does not hold and the engine was built with `onChecksumMismatch: 'throw'`.
 * `rule` is `id@version`; `pointer` is where the rule stands in the rules the caller gave
 * (`/rules/2`), absent for a rule a hook added. Frozen at creation.
 */
export class ChecksumMismatchError extends PPEError {
  public readonly rule: string;
  public readonly pointer: string | undefined;

  constructor(rule: string, pointer?: string) {
    rule = str('ChecksumMismatchError', 0, rule);
    pointer = optStr('ChecksumMismatchError', 1, pointer);
    const shown = clipText(rule, 256, '... [clipped]');
    super(
      `Checksum mismatch for rule ${shown}${pointer === undefined ? '' : ` at ${pointer}`}`,
      'CHECKSUM_MISMATCH',
    );
    this.name = 'ChecksumMismatchError';
    this.rule = shown;
    this.pointer = pointer;
    sealEngineError(this, new.target, ChecksumMismatchError);
  }
}

markEngineError(ChecksumMismatchError);
