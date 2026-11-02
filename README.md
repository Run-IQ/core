# @run-iq/core

The Run-IQ rule engine. It evaluates a set of versioned rules against input data and returns the result, the contribution of each rule, and a trace of how it got there.

The engine knows nothing about any business domain. Calculation logic comes from plugins (for example [`@run-iq/plugin-fiscal`](https://github.com/Run-IQ/plugin-fiscal)), and rule conditions come from a DSL evaluator (for example [`@run-iq/dsl-jsonlogic`](https://github.com/Run-IQ/dsl-jsonlogic)).

## Install

```bash
npm install @run-iq/core@next
```

The 1.0 line, built on the rule contract of [`@run-iq/spec`](https://github.com/Run-IQ/spec), is published under the `next` tag. Requires Node.js 20 or later.

## Example

```ts
import { PPEEngine, computeRuleChecksum } from '@run-iq/core';

// A calculation model: input + params -> number
const percentage = {
  name: 'PERCENTAGE',
  version: '1.0.0',
  validateParams: (p) => ({ valid: typeof p?.rate === 'number' }),
  calculate: (input, _rule, p) => input[p.base] * p.rate,
};

const engine = new PPEEngine({
  plugins: [
    { name: 'demo', version: '1.0.0', onInit: (ctx) => ctx.modelRegistry.register(percentage) },
  ],
  dsls: [],
});

const draft = {
  id: 'shipping-fee',
  version: 1,
  model: 'PERCENTAGE',
  params: { base: 'orderTotal', rate: 0.05 },
  priority: 1,
  effectiveFrom: new Date('2025-01-01'),
  effectiveUntil: null,
  tags: [],
};
const rule = { ...draft, checksum: computeRuleChecksum(draft) };

const result = await engine.evaluate([rule], {
  requestId: 'order-42',
  data: { orderTotal: 200 },
  meta: { tenantId: 'acme', effectiveDate: new Date('2025-06-01') },
});

result.value; // 10
result.breakdown; // [{ ruleId: 'shipping-fee', contribution: 10, modelUsed: 'PERCENTAGE' }]
```

## Concepts

- **Rule**: a model name, its params, an optional condition, a priority and a validity period. Each rule carries a SHA-256 `checksum`, computed by `computeRuleChecksum` over the canonical form defined in `@run-iq/spec`. A rule whose checksum does not match its content is skipped.
- **Calculation model**: a pure function `(input, rule, params) => number`. Plugins register models.
- **Plugin**: registers models and can hook into `beforeEvaluate` / `afterEvaluate`.
- **DSL evaluator**: decides whether a rule's `condition` applies to the input.
- **Snapshot**: an optional record of every evaluation, saved through an adapter you provide. A `requestId` whose snapshot already exists is refused with `DUPLICATE_REQUEST`; until Task 10 core returns no stored decision.

## Plugins fail closed

A decision is never returned without the work a plugin was to do. Every hook failure is a `PluginHookError` (`plugin`, `hook`, `cause`); `onError` is called on every plugin and nothing is saved.

- `beforeEvaluate` fails the evaluation when it throws or times out, returns a malformed result or a state that is not JSON, returns an input that fails the checks of the caller's input (bounds, `validateProofInput`, strict mode), drops a rule without a skip, returns a rule under the `id@version` of a given rule with another content, or adds a rule whose checksum does not hold. Changing the data of a valid input is allowed.
- `afterEvaluate` cannot change the decision: a change to `value`, `outputs`, the applied or skipped rules, `breakdown`, `trace` or any other field fails the evaluation. It may set `meta` and its own `pluginState` entry.

## How `evaluate()` works

1. Check the options and the number of rules (`maxRules`), then validate the input: its bounds (`maxInputDepth`, `maxInputLeaves`) and its canonical form (`validateProofInput` of `@run-iq/spec`)
2. Refuse a `requestId` whose snapshot already exists (`DuplicateRequestError`, code `DUPLICATE_REQUEST`)
3. Verify rule checksums and params
4. Run plugin `beforeEvaluate` hooks (fail closed: see below)
5. Filter rules by validity period, tags and condition
6. Resolve conflicts between rules by priority
7. Run the models and sum their contributions
8. Run plugin `afterEvaluate` hooks (they cannot change the decision)
9. Save the snapshot

Rules that are not applied appear in `result.skippedRules` with a reason (`CONDITION_FALSE`, `CHECKSUM_MISMATCH`, `INVALID_RULE`, `INACTIVE_DATE`, ...). `INVALID_RULE` marks a malformed rule whose checksum cannot be verified: an invalid date, `effectiveUntil` not after `effectiveFrom`, an absent or non-string `checksum`, a non-integer `version`. Its `detail` field names the rule (`id@version`) and the reason.

## Options

| Option               | Default                                       |                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict`             | `true`                                        | Requires the evaluation date (`meta.effectiveDate` or `meta.dates.effective`), throws on rule conflicts and on snapshot failures                                                                                 |
| `onConflict`         | `'throw'` in strict mode, otherwise `'first'` | What to do when two rules have the same priority                                                                                                                                                                 |
| `onChecksumMismatch` | `'skip'`                                      | `'throw'` to fail instead of skipping the rule. Covers checksum mismatches (throws `Error`) and malformed rules (throws `ValidationError`)                                                                       |
| `snapshot`           | none                                          | Adapter used to persist evaluations                                                                                                                                                                              |
| `dryRun`             | `false`                                       | Evaluate without saving a snapshot                                                                                                                                                                               |
| `timeout`            | `{ dsl: 100, hook: 500 }` ms                  | Time limits for conditions, hooks and the whole pipeline                                                                                                                                                         |
| `limits`             | `DEFAULT_LIMITS`                              | The bounds of an evaluation, see below. A value that is not a positive integer, an unknown key, or a `maxInputDepth` above 1000 throws `ValidationError` at construction                                         |
| `inputSeed`          | none                                          | `{ secret }` (at least 32 bytes) or `{ derive(requestId) }` (exactly 32 bytes): where the salt of the input digest will come from. Only checked for now: the secret at construction, `derive` at each evaluation |

`evaluate(rules, input, options?)` takes `referentials`, `ruleSets`, `requested` and `supersedes`. They are accepted and checked by name (`unknown evaluate option: foo` throws `ValidationError`), and change nothing yet: each is wired by its own task.

## Limits

`DEFAULT_LIMITS` bounds an evaluation. Passing a limit throws `EngineLimitError` (`limit`, `max`, `actual`) before anything is evaluated or saved; nothing is truncated. `maxRules` (100 000), `maxInputLeaves` (500 000, the leaves of the input tree: scalars, lists and empty objects, on every path) and `maxInputDepth` (128 levels of containers) are enforced; the others (`maxInstances`, `maxCollectionLength`, `maxStrata`, `maxSegments`, `maxRecursionDepth`, `maxReferentialNodes`, `maxGroupDepth`) are held for the tasks that need them. For an input bound, `actual` is the first value past the limit (`max + 1`): the walk stops there. The scale tests (`npm run test:heavy`) hold the defaults against a written budget: 100 000 simple rules in under 10 s, an input of 500 000 leaves checked in under 3 s.

## Reading facts by JSON pointer

A rule reads facts of its evaluation context by RFC 6901 pointer: `/revenue/total` in `data`, `/$dates/effective`, `/$dimensions/country`, `/$outputs/risk`. A DSL declares them with `listVariables(expression)`, a model with `listVariables(params)`; `readsOf(rule, dsl, model)` joins them. Pointers are compared as they are: `/children/01/age` names no element (a list index has no leading zero), `-` is refused, and two spellings of "é" are two facts. A `listVariables` that throws, or returns anything but pointers (a dotted path `revenue.total`), leaves the reads of its rule undeclared, with a diagnostic; `result.missingFacts` lists, sorted, the pointers read by the conditions and absent from the context (facts of `data`, `/$dates/...`, `/$dimensions/...`; not yet the reads of a model). A rule whose `listVariables` failed is still evaluated, its reads unknown, and only the diagnostic says so until 9M1 adds the `provisional` status. A `listVariables` must return an array of at most `MAX_LISTED_POINTERS` (100000) pointers; the root `''`, `/$outputs`, `/$bounds` and `/$selected` without a name are invalid paths. The pointer functions of the spec are re-exported: `parsePointer`, `formatPointer`, `JsonPointer`.

Any other `meta` key (a misspelled `effectivedate`, `userId`) is refused: `/meta has an unknown key "effectivedate"`. The input `meta` also takes `dates` (named dates, `Date` or string), `assertions` (the provenance of facts) and `dimensions` with several values (`{ country: ['FR', 'US'] }`). `normalizeMeta` writes them canonically: dates as a civil date or `YYYY-MM-DDTHH:MM:SS.sssZ`, dimension values sorted without duplicates (one value as a string), tags sorted.

## Evaluating at a past date

`meta.effectiveDate` (or `meta.dates.effective`: given together they must name the same date) selects the rules that were in force at that date. A civil date is the start of that day in UTC. This lets you recompute an old result with the rules that applied at the time.

The window of a rule is `[effectiveFrom, effectiveUntil)`, as `@run-iq/spec` defines it: `effectiveUntil` itself is excluded. A bound is a `Date` (an instant) or a civil date `YYYY-MM-DD`, compared as a civil date in UTC. The checksum requires `effectiveUntil` to be after `effectiveFrom`, so a one-day rule ends the next day (`2025-03-01` to `2025-03-02`). A bound spec refuses (or a civil bound with an IANA `timeZone`, which core cannot resolve yet) skips that rule as `INVALID_RULE`, with spec's code and message in `detail`.

## Rules stored as JSON

Rules loaded from a database or an API have their dates as strings. `hydrateRule` and `hydrateRules` convert them back (an instant becomes a `Date`, a civil date stays a string). They keep the stored `checksum`, so a row changed after sealing is still skipped as `CHECKSUM_MISMATCH`.

They throw a `ValidationError` on an invalid definition, for example a date-time without a time zone, `effectiveUntil` not after `effectiveFrom`, missing `params`, or a non-integer `version`. Its `reasons` list every problem found.

## License

Business Source License 1.1. Production use is allowed, except offering the package as a hosted or embedded service that competes with the licensor. It converts to Apache 2.0 on 2030-01-01. See [LICENSE](LICENSE).
