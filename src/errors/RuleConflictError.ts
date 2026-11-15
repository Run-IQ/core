import { PPEError } from './PPEError.js';
import { num, strings } from './args.js';
import { markEngineError, sealEngineError } from './engineError.js';

export class RuleConflictError extends PPEError {
  constructor(
    public readonly ruleIds: readonly string[],
    public readonly priority: number,
  ) {
    ruleIds = strings('RuleConflictError', 0, ruleIds);
    priority = num('RuleConflictError', 1, priority);
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
