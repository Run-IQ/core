/**
 * Something that went wrong without stopping the evaluation, reported in
 * `EvaluationResult.diagnostics` instead of being swallowed (e.g. a hook that threw).
 */
export interface Diagnostic {
  readonly source: 'hook' | 'engine';
  /** The plugin concerned, when `source` is `'hook'` or the engine reports on a plugin. */
  readonly plugin?: string | undefined;
  readonly hook?: 'beforeEvaluate' | 'afterEvaluate' | undefined;
  readonly message: string;
}
