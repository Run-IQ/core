import type { Referential } from '@run-iq/spec';

/**
 * The rule set a rule belongs to: a published pack (`id`, `version`, `digest`, the packs it
 * `imports`) or the caller's own rules (`local`). Shape only in 9L: each field is wired by its
 * own task (rule sets, time zones).
 */
export type RuleSetRef =
  | {
      readonly kind: 'pack';
      readonly id: string;
      readonly version: string;
      readonly digest: string;
      readonly imports?: readonly string[] | undefined;
      readonly timeZone?: string | undefined;
    }
  | { readonly kind: 'local'; readonly timeZone?: string | undefined };

/**
 * The options of one `evaluate(rules, input, options?)`. Shape only in 9L: the engine checks the
 * names of the options and accepts these, and none of them changes the decision yet; each is
 * wired by its own task (referentials, rule sets, requested outputs, supersession).
 */
export interface EvaluateOptions {
  /** The referentials a rule's dimension may name (`ref`). */
  readonly referentials?: readonly Referential[] | undefined;
  /** The rule sets of the rules, for rules from several packs. */
  readonly ruleSets?: readonly RuleSetRef[] | undefined;
  /** The outputs asked for: the others are not computed. */
  readonly requested?: readonly string[] | undefined;
  /** The decision this one replaces, by digest, and why. */
  readonly supersedes?: { readonly digest: string; readonly reason: string } | undefined;
}

/** The names `evaluate` accepts as options. */
export const EVALUATE_OPTION_NAMES: readonly string[] = Object.freeze([
  'referentials',
  'ruleSets',
  'requested',
  'supersedes',
]);
