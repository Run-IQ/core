# @run-iq/core

Parametric Policy Engine (PPE) — a deterministic, plugin-driven rules engine for financial and regulatory computation.

## Install

```bash
npm install @run-iq/core
```

## Quick start

```typescript
import { PPEEngine } from '@run-iq/core';

const engine = new PPEEngine({
  plugins: [fiscalPlugin],
  dsls: [jsonLogicEvaluator],
  snapshot: snapshotAdapter,
  strict: true,
  timeout: { dsl: 100, hook: 500, pipeline: 5000 },
});

const result = await engine.evaluate(rules, {
  requestId: 'req-001',
  data: { grossSalary: 2_500_000 },
  meta: { tenantId: 'tenant-1' },
});

console.log(result.value);       // aggregated value
console.log(result.breakdown);   // per-rule contributions
console.log(result.trace);       // full audit trail
```

## Pipeline

The engine executes a 10-step pipeline on every call to `evaluate()`:

1. **Input validation** — sanitize and validate the input
2. **Idempotence check** — skip if `requestId` already processed
3. **beforeEvaluate hooks** — plugins enrich input
4. **Rule filtering** — date range, tags, DSL conditions
5. **Rule validation** — checksum + params verification
6. **Dominance resolution** — priority sort + conflict handling
7. **Execution** — models compute contributions (decimal-safe)
8. **afterEvaluate hooks** — plugins enrich result
9. **Snapshot** — persist immutable audit record
10. **Return** — final `EvaluationResult`

## Key concepts

| Concept | Description |
|---|---|
| **Rule** | Declarative policy unit with model, params, condition, priority, and date range |
| **CalculationModel** | Pure function `(input, rule, params) → number` — registered by plugins |
| **DSLEvaluator** | Evaluates rule conditions (e.g. JSONLogic, CEL) — pluggable |
| **PPEPlugin** | Lifecycle hooks + model registration |
| **Snapshot** | Immutable audit record with full rule copies and DSL versions |

## Retroactive calculation

Pass `effectiveDate` to evaluate rules as of a specific date:

```typescript
const result = await engine.evaluate(rules, {
  requestId: 'req-002',
  data: { grossSalary: 2_500_000 },
  meta: {
    tenantId: 'tenant-1',
    effectiveDate: new Date('2023-12-01'),
  },
});
```

## Hydrating rules from JSON

When rules come from an API or database as JSON, date fields are strings. Use `hydrateRule` to convert them:

```typescript
import { hydrateRule, hydrateRules } from '@run-iq/core';

const rule = hydrateRule(jsonFromApi);
const rules = hydrateRules(jsonArrayFromDb);
```

## Exported errors

| Error | Code | When |
|---|---|---|
| `RuleConflictError` | `RULE_CONFLICT` | Same-priority rules in strict mode |
| `ModelNotFoundError` | `MODEL_NOT_FOUND` | Rule references unregistered model |
| `DSLNotFoundError` | `DSL_NOT_FOUND` | Rule condition uses unregistered DSL |
| `DSLTimeoutError` | `DSL_TIMEOUT` | DSL evaluation exceeds timeout |
| `DSLEvaluationError` | `DSL_EVALUATION_ERROR` | DSL syntax or runtime error |
| `SnapshotFailureError` | `SNAPSHOT_FAILURE` | Snapshot save fails in strict mode |
| `ValidationError` | `VALIDATION_ERROR` | Input validation fails |

## Requirements

- Node.js >= 20
- TypeScript >= 5.4

## License

MIT
