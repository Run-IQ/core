import { PPEError } from './PPEError.js';

export class RuleConflictError extends PPEError {
  constructor(
    public readonly ruleIds: readonly string[],
    public readonly priority: number,
  ) {
    super(
      `Rule conflict: rules [${ruleIds.join(', ')}] have the same priority ${priority}`,
      'RULE_CONFLICT',
    );
    this.name = 'RuleConflictError';
  }
}
