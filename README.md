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

## Threat model of the plugin boundary

The boundary protects **data**, completely, and does not isolate **code**.

- **Protected:** the input and the rules, the ledger of the rules that were given, every value plugin code hands the engine, the decision, the record, and the error the caller receives. The engine touches plugin data in **one place**, the port (`src/engine/pluginPort.ts`): a plugin, a model or a DSL is read **once**, when it is registered (its `name`, `version` and functions; the engine keeps those copies and never reads the object again), a function it gave is called through the port, and what comes back is read through the one bounded reader (copied once, bounded, its text weighed by its exact serialized length, never kept by reference). A test (`tests/integration/hostile-proxy.test.ts`) runs a whole evaluation with a plugin, a model and a DSL made only of Proxies that log every access, and fails if any access happens outside the port; `CROSSING_POINTS` in `src/engine/pluginBoundary.ts` lists each callback, its contract (synchronous or not) and its reader, and a table-driven test runs against each one an oversized value, a forged engine error (of each exported class), an `undefined` hidden in a list and a promise. Whatever a plugin throws, an engine class included, is a plugin fault, held as **text**: its `name` (128 characters), `message` (1 024) and string `code` (64), each cut with a visible `... [clipped]`; no object, copy or graph of a plugin is kept, recorded or handed to the caller. The error the caller receives is always one the engine built. A finding of that kind is a bug in core.
- **Promises.** A callback whose contract is synchronous (`onInit`, `onError`, `validateParams`, `calculate`, the `listVariables` and `evaluate` of a DSL) that returns a thenable breaches it: the thenable is never awaited, its rejection is handled, and the call is a plugin fault (`returned a promise`); `onInit` failing makes construction fail. The hooks `beforeEvaluate` and `afterEvaluate` may be async: they are awaited within the time limit of the evaluation, a rejection is a fault of the plugin, and no rejection is ever unhandled. A DSL cannot be slow: the engine does not wait for it, and `timeout.dsl` is kept for the sandbox of phase 3.
- **Not isolated:** plugin code from other plugin code in the same process. One plugin changing another plugin's closure, its `this` state or its prototype, or patching globals, is out of reach of the engine in a single JavaScript realm. The declarations a model gives when it is registered (`output`, and an evaluator's `capabilities`) are copied at that moment, and the functions of a model are taken when an evaluation starts; the `this` state a model keeps is its plugin's. Installing an in-process plugin means trusting its code. Untrusted code belongs in the sandbox (phase 3): out of process or in a separate realm, with only JSON crossing it, checked by this boundary.
- The decision depends on the canonical input only: key order, `-0`, the order and duplicates of tags and dimension values, and the form of a date are not part of it, and a property test holds the engine to it. The engine hands the data over in the caller's key order, so a model must read facts by pointer and must not depend on that order. An `undefined` held anywhere in `meta.dimensions`, `meta.dates`, `meta.assertions` (members and list items alike), in `data`, in a rule, or in anything a plugin returns, is refused with its pointer; a member of `meta` that is itself `undefined` is absent, as for spec.

## Plugins fail closed

A decision is never returned without the work a plugin was to do. Every hook failure is a `PluginHookError` (`plugin`, `hook`, `cause`); `onError` is called on every plugin and nothing is saved.

- `beforeEvaluate` fails the evaluation when it throws or times out, returns a malformed result or a state that is not JSON, returns an input that fails the checks of the caller's input (bounds, `validateProofInput`, strict mode), drops a rule without a skip, returns a rule under the `id@version` of a given rule with another content, or adds a rule whose checksum does not hold. Changing the data of a valid input is allowed.
- A hook is handed frozen data (the input, and the engine's rules, which are deep-frozen and hold no `Date`: every date in a rule is a string), and what it returns is read once, bounded, copied and checked against a ledger of the rules that were given: nothing rewritten, doubled, dropped, invented, or re-added under a name that already took part. A plugin skip has the reason `PLUGIN` (or one of the deprecated plugin reasons) and the keys `rule`, `reason`, `detail`.
- Models and DSLs receive views that refuse every write with a `FrozenViewWriteError`, and never a `Date` (the dates of a rule, in `params`, `condition.value` and extension fields too, are strings). A model that writes into its arguments, or into the params in `validateParams`, is excluded for that rule (`MODEL_ERROR`); a DSL that does is a `DSL_ERROR` exclusion; a `TypeError` of the model's own still fails the evaluation. `Object.freeze` and `Object.preventExtensions` on a view are not writes (the data is frozen already). The registries are fixed when an evaluation starts, with the functions of each model and DSL taken at that moment: a model registered during it, a method of a model replaced during it, or an `output` declaration rewritten during it, is not seen, and a rule a hook adds with such a model is refused. An error is taken for a refused write only if a view of the very call that is judged threw it; a model that throws its own `FrozenViewWriteError`, or one it caught in another call, fails the evaluation. A model's own throw (a getter of its output that throws, and a throw while its `validateParams` result is read, included) fails the evaluation as an `UnexpectedEngineError` whose `cause` is the text of what was thrown (`name`, `message`, `code`): the caller never receives the object a plugin holds, nor an engine error class a plugin built. The result of `validateParams` must be a plain `{ valid: true | false, errors?: string[] }`: anything else (a `valid` that is not a boolean, an unknown key) excludes that rule with `MODEL_ERROR`.
- `beforeEvaluate` may change `data`, not `meta`: the caller's declarations (the date, the dates, the dimensions, the tags) are not the plugin's to change. A plugin skip is recorded as `plugin <name>: <detail>`. The total the returns of all the hooks make the engine read (the input a hook returns included) is held to `maxHookLeaves` (600 000).
- A plugin's `onError` receives a deep-frozen copy of the failure, its `cause` chain included (engine-built: the text of what a plugin threw), and the engine's own frozen copy of the input, never the caller's object. The `cause` of a `PluginHookError` is the text of what the plugin threw; the message of the error is built from that text. A throw of `onInit` is a `PluginHookError` with `hook: 'onInit'`.
- A value that is `undefined` in `meta.dimensions`, `meta.dates` or a rule is refused with its pointer, and so is an empty `meta.dimensions` (omit it to declare no dimensions): the canonical form cannot tell it from no `dimensions`, and the decision must depend on the canonical input only. `beforeEvaluate` may not change the shape of `meta` either (a `tags: []` where there was no `tags`).
- The rules in the result are frozen.
- `afterEvaluate` cannot change the decision: a change to `value`, `outputs`, the applied or skipped rules, `breakdown`, `trace` or any other field fails the evaluation. It may set `meta` and its own `pluginState` entry.

## How `evaluate()` works

1. Check the options and the number of rules (`maxRules`), then validate the input: its bounds (`maxInputDepth`, `maxInputLeaves`) and its canonical form (`validateProofInput` of `@run-iq/spec`)
2. Refuse a `requestId` whose snapshot already exists (`DuplicateRequestError`, code `DUPLICATE_REQUEST`)
3. Verify rule checksums and params
4. Run plugin `beforeEvaluate` hooks (fail closed: see above)
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

`DEFAULT_LIMITS` bounds an evaluation. Passing a limit throws `EngineLimitError` (`limit`, `max`, `actual`, and the `pointer` when the bound is a place in the data, cut at 1 024 characters) before anything is evaluated or saved; nothing is truncated. The size limits count nodes: each object key, each list element and each scalar (a list and an empty object count one too), and **every 64 characters of the exact serialized length of a string or a key add one node, each time it is read** (the quotes and every JSON escape count as JSON writes them: `\n` is 2, a control character 6): a string shared by many rules costs what it weighs in each of them. Enforced: `maxRules` (100 000), `maxInputLeaves` (500 000 nodes of the input tree), `maxInputDepth` (128 levels of containers), `maxStringLength` (1 000 000 characters of one string or key, in the input, the `requestId`, a rule and what a hook or a model returns), `maxRuleLeaves` (100 000 nodes of one rule, given, returned by a hook or held in a skip, and of one value a model returns), `maxRuleSetNodes` (2 000 000 nodes of all the rules the caller gives, together), `maxHookLeaves` (600 000: **one budget for everything plugin code hands the engine in one evaluation**: the returns of all the hooks, the input each hook returns, what `afterEvaluate` changes, the details of skips, the outputs of the models, and the text of the results of `validateParams`, of the verdicts of the DSLs, of the answers of `listVariables` and of the errors of the DSLs; the last four count their text only), `maxTraceNodes` (10 000 000: the nodes of the input times the steps of the trace, since each step records the input it was computed on; an input of `maxInputLeaves` nodes is reachable with up to twenty applied rules, and past that this bound decides) and `maxRecordLength` (256 000 000 characters of the serialized record; the strings of the rules and the input, the details of skips and the `meta` and `pluginState` plugins set are weighed against it before anything is cloned, and where the runtime cannot build a string that long the same error is raised, never a raw `RangeError`). The others (`maxInstances`, `maxCollectionLength`, `maxStrata`, `maxSegments`, `maxRecursionDepth`, `maxReferentialNodes`, `maxGroupDepth`) are held for the tasks that need them. For an input bound, `actual` is the first value past the limit (`max + 1`): the walk stops there. The scale tests (`npm run test:heavy`) hold the defaults against a written budget, on the costliest shapes (wide objects of about 48 000 keys, text that JSON escapes), each with at least a quarter of its budget to spare on the reference machine: 100 000 simple rules in under 10 s, with or without plugins; caller rules of `maxRuleSetNodes` wide nodes in under 10 s; a hook return of `maxHookLeaves` wide nodes in under 8 s; an input of 500 000 nodes checked in under 3 s; a rule of 100 000 nodes read and evaluated in under 3 s; and the worst case, with caller rules at `maxRuleSetNodes`, one hook at `maxHookLeaves`, plain and escaped strings at `maxStringLength`, and an input at the size `maxTraceNodes` allows, in under 10 s. A text shared by 2 200 skips, or by 2 200 `validateParams` answers, is refused by name long before memory runs out.

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
