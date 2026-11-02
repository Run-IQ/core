import { SpecError, verifyRuleChecksum } from '@run-iq/spec';
import type { Rule } from '../types/rule.js';
import { describeThrown, ruleLabel } from '../utils/values.js';

/** True when the checksum of `rule` is the checksum of its content; false when spec cannot tell. */
function intact(rule: Rule): { ok: true } | { ok: false; why: string | undefined } {
  try {
    return verifyRuleChecksum(rule) ? { ok: true } : { ok: false, why: undefined };
  } catch (error) {
    if (!(error instanceof SpecError)) throw error;
    return { ok: false, why: describeThrown(error) };
  }
}

/**
 * Checks the rules a `beforeEvaluate` hook returned against the rules it was given.
 *
 * - A returned rule with the `id@version` of a given rule is that rule: its checksum is the
 *   given one and it is the checksum of its content. A rule rewritten under the same name,
 *   with its checksum recomputed or not, is refused.
 * - A returned rule with another `id@version` is an added rule: its checksum is verified as
 *   a source rule's is (`verifyRuleChecksum`), and a mismatch, or a rule spec cannot checksum, is
 *   refused.
 *
 * Throws `Error` on the first refusal, in the order of the returned rules. The engine turns it
 * into a `PluginHookError`.
 */
export function checkHookRules(
  pluginName: string,
  given: ReadonlyArray<Rule>,
  returned: ReadonlyArray<Rule>,
): void {
  const checksums = new Map<string, Set<string>>();
  for (const rule of given) {
    const label = ruleLabel(rule);
    checksums.set(label, (checksums.get(label) ?? new Set()).add(String(rule.checksum)));
  }
  for (const rule of returned) {
    const label = ruleLabel(rule);
    const known = checksums.get(label);
    const verdict = intact(rule);
    if (known !== undefined) {
      if (!known.has(String(rule.checksum)) || !verdict.ok) {
        throw new Error(
          `plugin ${pluginName} rewrote rule ${label}: its content is not the one it was given`,
        );
      }
    } else if (!verdict.ok) {
      throw new Error(
        verdict.why === undefined
          ? `plugin ${pluginName} added rule ${label} whose checksum does not match its content`
          : `plugin ${pluginName} added rule ${label}: ${verdict.why}`,
      );
    }
  }
}
