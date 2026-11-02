/**
 * Something the engine accepted and says so, reported in `EvaluationResult.diagnostics`: a
 * `listVariables` that does not conform (its rule's reads are unknown), rules a
 * `beforeEvaluate` hook added and that passed their checks. A fault that would change the
 * decision is never a diagnostic: it fails the evaluation (`PluginHookError`).
 */
export interface Diagnostic {
  readonly source: 'hook' | 'engine';
  /** The plugin concerned, when `source` is `'hook'` or the engine reports on a plugin. */
  readonly plugin?: string | undefined;
  readonly hook?: 'beforeEvaluate' | 'afterEvaluate' | undefined;
  readonly message: string;
}
