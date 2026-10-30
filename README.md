# @run-iq/core

The Run-IQ rule engine. It evaluates a set of versioned rules against input data and returns the result, the contribution of each rule, and a trace of how it got there.

The engine knows nothing about any business domain. Calculation logic comes from plugins (for example [`@run-iq/plugin-fiscal`](https://github.com/Run-IQ/plugin-fiscal)), and rule conditions come from a DSL evaluator (for example [`@run-iq/dsl-jsonlogic`](https://github.com/Run-IQ/dsl-jsonlogic)).

## Install

```bash
npm install @run-iq/core
```

Requires Node.js 20 or later.

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
  plugins: [{ name: 'demo', version: '1.0.0', onInit: (ctx) => ctx.modelRegistry.register(percentage) }],
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

result.value;     // 10
result.breakdown; // [{ ruleId: 'shipping-fee', contribution: 10, modelUsed: 'PERCENTAGE' }]
```

## Concepts

- **Rule**: a model name, its params, an optional condition, a priority and a validity period. Each rule carries a SHA-256 `checksum`. A rule whose checksum does not match its content is skipped.
- **Calculation model**: a pure function `(input, rule, params) => number`. Plugins register models.
- **Plugin**: registers models and can hook into `beforeEvaluate` / `afterEvaluate`.
- **DSL evaluator**: decides whether a rule's `condition` applies to the input.
- **Snapshot**: an optional record of every evaluation, saved through an adapter you provide. It is also used to make `requestId` idempotent.

## How `evaluate()` works

1. Validate the input
2. Return early if a snapshot already exists for `requestId`
3. Verify rule checksums and params
4. Run plugin `beforeEvaluate` hooks
5. Filter rules by validity period, tags and condition
6. Resolve conflicts between rules by priority
7. Run the models and sum their contributions
8. Run plugin `afterEvaluate` hooks
9. Save the snapshot

Rules that are not applied appear in `result.skippedRules` with a reason (`CONDITION_FALSE`, `CHECKSUM_MISMATCH`, `INVALID_RULE`, `INACTIVE_DATE`, ...). `INVALID_RULE` marks a malformed rule whose checksum cannot be verified: an invalid date, `effectiveUntil` not after `effectiveFrom`, an absent or non-string `checksum`, a non-integer `version`. Its `detail` field names the rule (`id@version`) and the reason.

## Options

| Option | Default | |
|---|---|---|
| `strict` | `true` | Requires `meta.effectiveDate`, throws on rule conflicts and on snapshot failures |
| `onConflict` | `'throw'` in strict mode, otherwise `'first'` | What to do when two rules have the same priority |
| `onChecksumMismatch` | `'skip'` | `'throw'` to fail instead of skipping the rule. Covers checksum mismatches (throws `Error`) and malformed rules (throws `ValidationError`) |
| `snapshot` | none | Adapter used to persist evaluations |
| `dryRun` | `false` | Evaluate without saving a snapshot |
| `timeout` | `{ dsl: 100, hook: 500 }` ms | Time limits for conditions, hooks and the whole pipeline |

## Evaluating at a past date

`meta.effectiveDate` selects the rules that were in force at that date. This lets you recompute an old result with the rules that applied at the time.

## Rules stored as JSON

Rules loaded from a database or an API have their dates as strings. `hydrateRule` and `hydrateRules` convert them back. They keep the stored `checksum`, so a row changed after sealing is still skipped as `CHECKSUM_MISMATCH`.

They throw a `ValidationError` on an invalid definition, for example a date-time without a time zone, `effectiveUntil` not after `effectiveFrom`, missing `params`, or a non-integer `version`. Its `reasons` list every problem found.

## License

Business Source License 1.1. Production use is allowed, except offering the package as a hosted or embedded service that competes with the licensor. It converts to Apache 2.0 on 2030-01-01. See [LICENSE](LICENSE).
