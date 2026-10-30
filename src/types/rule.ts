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
 * Accepted as engine input, it is looser than `ExecutableRule` so that rules written by hand
 * keep compiling: `dimensions` may be absent (the checksum treats it as `{}`), and `condition`
 * and `dominanceGroup` accept `undefined`. Every `ExecutableRule` is a `Rule`.
 */
export interface Rule extends Omit<
  ExecutableRuleBase,
  'condition' | 'dominanceGroup' | 'dimensions' | 'effectiveUntil'
> {
  /**
   * End of validity; `null` for no end. Inclusive in core until phase 2 aligns with spec's
   * `[from, until)`.
   */
  readonly effectiveUntil: Date | null;
  readonly condition?: Expression | undefined;
  readonly dominanceGroup?: string | undefined;
  /** Absent means no dimension, like `{}`. */
  readonly dimensions?: Readonly<Record<string, string>> | undefined;
  readonly [extension: string]: unknown;
}
