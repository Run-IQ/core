import { PPEError } from './PPEError.js';
import { checkArgs } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

export class RuleConflictError extends PPEError {
  constructor(
    public readonly ruleIds: readonly string[],
    public readonly priority: number,
  ) {
    checkArgs('RuleConflictError', [
      [ruleIds, 'S'],
      [priority, 'n'],
    ]);
    super(
      `Rule conflict: rules [${ruleIds.join(', ')}] have the same priority ${priority}`,
      'RULE_CONFLICT',
    );
    this.name = 'RuleConflictError';
    this.ruleIds = Object.freeze([...ruleIds]);
    // Frozen at creation: what the caller receives cannot be changed (B74).
    sealEngineError(this, new.target, RuleConflictError);
  }
}

markEngineError(RuleConflictError);
