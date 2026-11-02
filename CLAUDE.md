# CLAUDE.md

Run-IQ is a generic decision engine: every decision comes with a verifiable proof. This file is read first by any Claude session working in this repository, a new cloud session included. It holds what the owner has decided, and it is binding.

## 1. Founding principle: correctness and fail-closed behaviour come first

They come before convenience, compatibility and dates. The reputation of Run-IQ depends on them.

1. **The engine never guesses.** It applies only what is declared explicitly: the data given, the caller's declarations (scope, completeness, how a fact is justified) and the pack's rules. Each declaration is recorded in the proof.
2. **Nothing passes silently.** A fault either fails what it touches, or marks it with an explicit status: a pending rule with its reason, an output with its status, a verdict with its problem. Never accepted: a hiding default, a swallowed error, or a quiet diagnostic under a result that looks certain.
3. **A fault stops at what it touches.** A faulty rule makes only its outputs pending. The whole evaluation is refused for an invalid input, a failing plugin, a tampered rule or a failed save.
4. **Only rules in force have an effect.** A beaten, skipped or pending rule imposes nothing. While it is unknown whether a rule is in force, its effect is pending too.
5. **A verifier never means "trust".** It says `authentic` only for what it checked, and it says what it did not check.

You apply this yourself, in every job. The machine audit is a second net, not the first.

## 2. Fail-closed checklist

Check every changed line for:

1. **Swallowed errors.** A `catch` that returns a default, `continue`s, or only logs, when the fault changes the result.
2. **Defaults that hide an absence.** `?? 0`, `?? ''`, `|| []`, `?? true` on data that should exist; an absent value read as `false`, `0` or "no constraint".
3. **Leniency on unknown things.** An unknown field, key, option, kind or reason accepted without a signal where it changes meaning. A misspelled name must fail and name the field.
4. **Coercion.** Truthiness instead of `=== true`; a string, `NaN`, `-0` or an unsafe integer passing as a number; `null` read as absence.
5. **The checked copy and the used copy are not the same.** Getters, Proxies, a value read several times, input rewritten after a check.
6. **Plugins.** Any hook failure, malformed return, invalid input, rule rewritten under the same `id@version`, rule dropped without a skip, or change to the decision in `afterEvaluate` makes the evaluation fail with `PluginHookError`.
7. **Verdicts too kind.** A verifier that returns `authentic` or `consistent` while it skipped a check, without a notice; `consistent` where `invalid` is warranted; a revocation or an unsupported kind not refused.
8. **Limits.** Every limit is enforced, never truncated or clamped silently, and is held by a test.
9. **Integrity and storage.** A checksum mismatch, a failed save, a proof that cannot be sealed: the evaluation fails, and no decision comes out without its stored proof.
10. **Tests that cannot fail.** Every safety rule has a test that fails when the rule is removed. Show it by a mutation check in the PR.

**Every PR body has a "Fail-closed" section.** It lists every place where the change refuses, fails or marks something, and confirms that items 1 to 10 were checked. A finding against this checklist is never "minor enough to leave".

Other rigour: write the test first and show it failing; exact assertions; one mutation check per behavioural change; replay the full CI at the lockfile versions on Node 20 before asking for an audit; CI green before "audit OK". Public text is in English, with no em dash and no arrows in prose, and never uses the old internal names of the product.

## 3. Loop protocol with the machine session

The cloud session (you) and the machine session (on the owner's computer) talk only through the GitHub issue `Run-IQ/.github#1` and the pull requests. The owner does not intervene in the loop.

- **Branches.** One `cloud/<task>` branch per job, cut from `refonte/phase-2`. Pull requests go into `refonte/phase-2`.
- **Comments.** Every comment you post starts with `Cloud session:`. The machine session's start with `Machine session:`.
- **Sequence.** `Cloud session: ready for audit <PR link>`, then audit comments, then `Cloud session: fixes pushed` (one answer per finding, by number, Minor ones included), repeated until `Machine session: audit OK`.
- **Merge.** Only after `Machine session: audit OK`, with CI green and the base unchanged: a fast-forward only, `git push origin cloud/<task>:refonte/phase-2`. Then post `Cloud session: merged <sha>` and wait for the next job. Commits are kept, never squashed.
- **Owner questions.** For a product, licence or irreversible choice, any publish, tag or release, any push to `master` or `main`, deleting a repository or another branch, a change to spec while working on a core task, or a budget choice: post `Cloud session: BLOCKED (owner decision) <why>` and wait.
- **Waiting.** Never end the session while waiting: poll issue #1 and the PR every 2 minutes for a new `Machine session:` comment, and re-arm the watch when it expires.
- **No footers.** No "Generated with", no `Co-Authored-By`, no signature line in commits, pull requests or comments. Tools that append one (`gh api`, some MCP create calls) must be followed by an edit that removes it, then checked.
- **The owner is the sole author** of every commit.
- **Never:** push to `master` or `main`, publish a package, create or move a tag, create a repository, force-push, print or store a token.

## 4. Owner decisions

Decisions of 2 November 2026 that apply to core. Items marked "from <task>" are decided and are not in the code yet; the code follows when that task lands.

- Every hook failure fails the evaluation with `PluginHookError`: a throw, a timeout, a malformed result, an invalid input, a state that is not JSON, a rule dropped without a skip. `onError` is called on every plugin and nothing is saved.
- A rule returned by `beforeEvaluate` under the same `id@version` with a different content fails the evaluation. A rule a hook adds has its checksum verified like a source rule.
- `afterEvaluate` cannot change the decision (`value`, `outputs`, applied, skipped or pending rules, `breakdown`, `trace`). It may only set its own `pluginState` entry and `meta`.
- Unknown `meta` keys and unknown `evaluate` options are refused by name, whatever their value.
- Input values that are not portable JSON (`NaN`, `Infinity`, a `Date`, `undefined`, a function, a symbol, a `BigInt`, an object that is not plain) are refused with their pointer before any hook runs.
- From 9M1: the default of `onChecksumMismatch` is `throw`. A rule whose `listVariables` fails is `provisional` instead of being evaluated with unknown reads.
- From Task 10: a store failure fails the evaluation.
- From 9M2: only rules in force have an effect, so the exceptions of a beaten carrier do not apply.
- Tags absent means no tag filter (D-38). A given list is complete unless the caller declares otherwise.

## 5. Rule for future decisions

Every owner decision the machine session posts on issue #1 starts with `Machine session: DECISION`. Add it to the "Owner decisions" section of this file, in the affected repository, in your next pull request. The audit checks that it is there. A decision that applies to both repositories goes in both.
