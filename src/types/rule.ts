import type { ExecutableRuleBase } from '@run-iq/spec';

/** A rule condition: an expression in a registered DSL. */
export interface Expression {
  readonly dsl: string;
  readonly value: unknown;
}

/**
 * A rule ready for evaluation: the `ExecutableRule` of `@run-iq/spec` (named fields, `Date`
 * bounds, `checksum`, and plugin extension fields at the top level, which enter the checksum).
 * A plugin narrows it by extension, e.g. `interface FiscalRule extends Rule { params: ... }`.
 *
 * **Dates.** The engine holds no `Date`: `effectiveFrom`, `effectiveUntil` and every date in
 * `params`, `condition.value` and the extension fields are strings in the rules it hands out
 * (hooks, models, DSLs) and in the result and the record: a civil date `YYYY-MM-DD` stays civil,
 * any other becomes the instant `YYYY-MM-DDTHH:MM:SS.sssZ`. A `Date` is accepted as input and
 * written so when the rule is read; the checksum is unchanged. The type keeps `Date` in the
 * bounds because a caller writes them so.
 *
 * Accepted as engine input, it is looser than `ExecutableRule` so that rules written by hand
 * keep compiling: `dimensions` may be absent (the checksum treats it as `{}`), and `condition`
 * and `dominanceGroup` accept `undefined`. Every `ExecutableRule` is a `Rule`.
 */
export interface Rule extends Omit<
  ExecutableRuleBase,
  'condition' | 'dominanceGroup' | 'dimensions'
> {
  readonly condition?: Expression | undefined;
  readonly dominanceGroup?: string | undefined;
  /** Absent means no dimension, like `{}`. */
  readonly dimensions?: ExecutableRuleBase['dimensions'] | undefined;
  readonly [extension: string]: unknown;
}
