import { SpecError, verifyRuleChecksum } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import type { SkippedRule } from '../types/result.js';
import type { RuleValidator } from '../security/RuleValidator.js';
import { ruleLabel } from '../utils/values.js';
import { compareRuleIdentity } from './resolveTie.js';

/** True when the checksum of `rule` is the checksum of its content; false when spec cannot tell. */
function intact(rule: Rule): boolean {
  try {
    return verifyRuleChecksum(rule);
  } catch (error) {
    if (!(error instanceof SpecError)) throw error;
    return false;
  }
}

/** The given rules of one label: how many, and the checksums they carry. */
interface Given {
  count: number;
  readonly checksums: Set<string>;
}

/**
 * Checks the rules and the skips a `beforeEvaluate` hook returned against the rules it was given
 * (`given`: copies the hook could not write into). Every rule of the decision is a given rule or
 * a verified new one; nothing is rewritten, doubled, dropped or invented in silence.
 *
 * - A returned rule with the `id@version` of a given rule is that rule: its checksum is a given
 *   one, and it is the checksum of its content. Rewritten under the same name, with its checksum
 *   recomputed or not, it is refused.
 * - A returned rule with another `id@version` is an added rule: it goes through the same
 *   validation as a source rule (`RuleValidator`: checksum, then the params its model accepts),
 *   and it may appear once.
 * - A skip names a given rule (same label, a given checksum, intact), and that rule is not also
 *   returned.
 * - For each given label, the rules returned and skipped together are as many as were given:
 *   fewer is a loss without a skip, more is a rule counted twice.
 *
 * Throws `Error` on the first refusal; the engine turns it into a `PluginHookError`. Returns the
 * labels of the added rules, sorted, for the diagnostic.
 */
export function checkHookRules(
  pluginName: string,
  given: ReadonlyArray<Rule>,
  returned: { readonly rules: ReadonlyArray<Rule>; readonly skipped: ReadonlyArray<SkippedRule> },
  validator: RuleValidator,
): string[] {
  const known = new Map<string, Given>();
  for (const rule of given) {
    const label = ruleLabel(rule);
    const entry = known.get(label) ?? { count: 0, checksums: new Set<string>() };
    entry.count += 1;
    entry.checksums.add(String(rule.checksum));
    known.set(label, entry);
  }
  const seen = new Map<string, number>();
  const added = new Set<string>();

  for (const rule of returned.rules) {
    const label = ruleLabel(rule);
    seen.set(label, (seen.get(label) ?? 0) + 1);
    const entry = known.get(label);
    if (entry !== undefined) {
      if (!entry.checksums.has(String(rule.checksum)) || !intact(rule)) {
        throw new Error(
          `plugin ${pluginName} rewrote rule ${label}: its content is not the one it was given`,
        );
      }
      continue;
    }
    if (added.has(label)) {
      throw new Error(`plugin ${pluginName} added rule ${label} more than once`);
    }
    added.add(label);
    const [refused] = validator.validate([rule]).invalid;
    if (refused !== undefined) {
      throw new Error(
        `plugin ${pluginName} added rule ${label}: ${refused.detail ?? refused.reason}`,
      );
    }
  }

  for (const skip of returned.skipped) {
    const label = ruleLabel(skip.rule);
    seen.set(label, (seen.get(label) ?? 0) + 1);
    const entry = known.get(label);
    if (entry === undefined) {
      throw new Error(`plugin ${pluginName} skipped rule ${label}, which it was not given`);
    }
    if (!entry.checksums.has(String(skip.rule.checksum)) || !intact(skip.rule)) {
      throw new Error(
        `plugin ${pluginName} skipped rule ${label} with a content other than the one it was given`,
      );
    }
  }

  const lost: Rule[] = [];
  for (const rule of given) {
    const label = ruleLabel(rule);
    const entry = known.get(label) as Given;
    const total = seen.get(label) ?? 0;
    if (total > entry.count) {
      throw new Error(
        `plugin ${pluginName} returned rule ${label} ${total} times (rules and skips together), it was given ${entry.count}`,
      );
    }
  }
  // Fewer returned than given: each missing rule is named once, sorted by id then version.
  const left = new Map<string, number>(seen);
  for (const rule of given) {
    const label = ruleLabel(rule);
    const remaining = left.get(label) ?? 0;
    if (remaining > 0) left.set(label, remaining - 1);
    else lost.push(rule);
  }
  if (lost.length > 0) {
    const names = lost.sort(compareRuleIdentity).map(ruleLabel);
    throw new Error(`plugin ${pluginName} removed rules without a skip: ${names.join(', ')}`);
  }
  return [...added].sort();
}
