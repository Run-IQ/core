# `@run-iq/core` — Contrats publics pour l'écosystème
## Complément architectural v2.0

> **Statut** : Référence pour les consommateurs du Core (`@run-iq/dg`, `@run-iq/rule-registry`, `@run-iq/plugin-sdk`)
> **Version du Core** : 0.2.5
> **Ce document complète** : `docs/PPE_ARCHITECTURE.md` (autorité absolue)
> **Principe** : Le Core ne connaît aucun domaine, aucun consommateur. Ce document décrit
> ce que le Core **expose**, pas ce qu'il **fait** — la logique interne est dans PPE_ARCHITECTURE.md.

---

## 1. Catégorisation des exports

Le Core exporte ses APIs publiques en **trois catégories** selon le consommateur.
Chaque consommateur ne doit importer que sa catégorie — jamais au-delà.

```
Catégorie A — Logique d'exécution
  Consommée par : @run-iq/dg (via CoreNodeExecutor)
  Contenu :       PPEEngine, ModelRegistry, DSLRegistry
                  + tous les types nécessaires à l'exécution

Catégorie B — Contrats & validation de schéma
  Consommée par : @run-iq/rule-registry
  Contenu :       Rule (type), Expression (type), hydrateRule()
                  computeRuleChecksum(), ValidationResult
                  JAMAIS PPEEngine, JAMAIS DominanceResolver

Catégorie C — Abstractions plugins
  Consommée par : @run-iq/plugin-sdk (qui réexporte pour les plugins)
  Contenu :       PPEPlugin, PluginContext, CalculationModel
                  BeforeEvaluateResult, CalculationOutput
```

**Règle** : `@run-iq/rule-registry` ne consomme que la Catégorie B.
Il ne connaît jamais `PPEEngine`, `DominanceResolver`, ou `ExecutionPipeline`.

---

## 2. Le type Rule — source de vérité unique

Ce type est défini dans `core/src/types/rule.ts`. Toute copie, variante, ou
réinterprétation dans un autre package est **interdite**. Les consommateurs
importent `Rule` depuis `@run-iq/core` — point final.

```ts
export interface Expression {
  readonly dsl:   string     // identifie l'évaluateur dans DSLRegistry : "jsonlogic" | "cel"
  readonly value: unknown    // payload de la condition — opaque pour le Core
}

export interface Rule {
  readonly id:              string
  readonly version:         number
  readonly model:           string           // opaque → cherché dans ModelRegistry
  readonly params:          unknown          // opaque → passé au modèle sans inspection
  readonly condition?:      Expression | undefined   // condition d'activation unique
  readonly priority:        number           // arbitrage par DominanceResolver
  readonly effectiveFrom:   Date             // début de validité
  readonly effectiveUntil:  Date | null      // fin de validité (null = pas d'expiration)
  readonly tags:            readonly string[]
  readonly checksum:        string           // SHA-256 calculé par computeRuleChecksum
  readonly schemaVersion?:  string | undefined
  readonly dominanceGroup?: string | undefined
}
```

### Points critiques pour les consommateurs

| Champ | Ce que le consommateur doit savoir |
|---|---|
| `model` | String opaque. Le Core cherche le modèle dans `ModelRegistry`. Le rule-registry le stocke tel quel. |
| `params` | `unknown` intentionnel. Le Core le passe au modèle via `calculate(input, rule, params)`. Le rule-registry ne l'inspecte jamais. |
| `condition` | **Singulier** (pas un tableau). Une seule Expression avec `dsl` + `value`. Si plusieurs conditions sont nécessaires, le DSL les combine (ex: JSONLogic `{"and": [...]}`). |
| `checksum` | SHA-256 calculé par `computeRuleChecksum()`. Le Core le vérifie à l'exécution — si divergence → `CHECKSUM_MISMATCH`, règle skippée. |
| `effectiveFrom` / `effectiveUntil` | `Date` objects. Le `RuleFilter` du Core filtre les règles hors de la période effective. |
| `tags` | `readonly string[]`. Le `RuleFilter` intersecte avec `input.meta.tags` si fourni. |

---

## 3. Exports publics complets — alignés sur le code

```ts
// core/src/index.ts — état réel v0.2.5

// ─── Catégorie A — Logique d'exécution ───────────────────────────────────────

export { PPEEngine }               from './engine/PPEEngine.js'
export { ModelRegistry }           from './registry/ModelRegistry.js'
export { DSLRegistry }             from './registry/DSLRegistry.js'

export type { PPEEngineConfig }    from './engine/PPEEngine.js'
export type { EvaluationInput }    from './types/input.js'
export type {
  EvaluationResult,
  BreakdownItem,
  SkippedRule,
  SkipReason
}                                   from './types/result.js'
export type {
  EvaluationTrace,
  TraceStep
}                                   from './types/trace.js'

// ─── Catégorie B — Contrats & validation ─────────────────────────────────────

export type { Rule, Expression }    from './types/rule.js'
export type {
  ISnapshotAdapter,
  Snapshot
}                                   from './types/snapshot.js'
export type {
  CalculationModel,
  CalculationOutput,
  ValidationResult,
  ParamDescriptor
}                                   from './types/model.js'
export type {
  DSLEvaluator,
  DSLSyntaxDoc,
  DSLOperatorDoc,
  DSLExampleDoc
}                                   from './types/dsl.js'

// Utilitaires de validation et sérialisation
export { hydrateRule, hydrateRules }    from './utils/hydrate.js'
export { canonicalStringify }           from './utils/json.js'
export { hashParams, computeRuleChecksum } from './utils/crypto.js'

// ─── Catégorie C — Abstractions plugins ──────────────────────────────────────

export type {
  PPEPlugin,
  PluginContext,
  BeforeEvaluateResult
}                                   from './types/plugin.js'

// ─── Erreurs ─────────────────────────────────────────────────────────────────

export {
  PPEError,
  RuleConflictError,
  ModelNotFoundError,
  DSLNotFoundError,
  SnapshotFailureError,
  DSLTimeoutError,
  DSLEvaluationError,
  PipelineTimeoutError,
  ValidationError,
}                                   from './errors/index.js'
```

---

## 4. Ce que chaque consommateur importe

### 4.1 `@run-iq/dg` — Catégorie A + B

```ts
// CoreNodeExecutor dans @run-iq/dg
import {
  PPEEngine,
  type PPEEngineConfig,
  type EvaluationInput,
  type EvaluationResult,
  type Rule,
  type DSLEvaluator,
  hydrateRule,
} from '@run-iq/core'
```

Le DG instancie `PPEEngine` et appelle `engine.evaluate(rules, input)` pour chaque nœud.
Il utilise `hydrateRule()` pour parser les payloads JSON du `RuleStore` en objets `Rule` typés.

### 4.2 `@run-iq/rule-registry` — Catégorie B uniquement

```ts
// RuleValidator dans @run-iq/rule-registry
import {
  type Rule,
  type Expression,
  type ValidationResult,
  hydrateRule,
  computeRuleChecksum,
} from '@run-iq/core'
```

**Ce que rule-registry fait avec ces imports :**

| Import | Usage |
|---|---|
| `Rule` (type) | Typer le résultat de `JSON.parse(payload)` après validation |
| `hydrateRule()` | Parser et valider un payload JSON en `Rule` avec runtime checks |
| `computeRuleChecksum()` | Calculer/vérifier le checksum SHA-256 d'une règle |
| `ValidationResult` | Type pour le résultat de `model.validateParams()` si besoin |

**Ce que rule-registry n'importe JAMAIS :**
- `PPEEngine` — il ne fait jamais d'évaluation
- `DominanceResolver`, `RuleFilter`, `ExecutionPipeline` — logique d'exécution
- `ModelRegistry`, `DSLRegistry` — il ne connaît pas les modèles/DSL enregistrés
- `PluginSandbox` — il ne sandbox rien

### 4.3 `@run-iq/plugin-sdk` — Catégorie C

```ts
import type {
  PPEPlugin,
  PluginContext,
  BeforeEvaluateResult,
  CalculationModel,
  CalculationOutput,
  ValidationResult,
  ParamDescriptor,
  Rule,
  Expression,
  EvaluationInput,
  EvaluationResult,
  SkippedRule,
  SkipReason,
  PPEError,
} from '@run-iq/core'

// Réexporte tout pour que les plugins n'importent que depuis @run-iq/plugin-sdk
```

---

## 5. `hydrateRule()` — le contrat de désérialisation

Le rule-registry stocke les règles sérialisées (`JSON.stringify(rule)` → `payload: string`).
Quand le DG ou le server a besoin d'une `Rule` typée, il appelle `hydrateRule()`.

```ts
/**
 * Parse un objet inconnu en Rule avec validation runtime.
 *
 * VALIDATIONS :
 *   ✓ id : string non vide
 *   ✓ model : string non vide
 *   ✓ priority : number
 *   ✓ version : number
 *   ✓ effectiveFrom : convertie en Date
 *   ✓ effectiveUntil : convertie en Date | null
 *   ✓ checksum : string
 *   ✓ params : passé tel quel (unknown)
 *   ✓ condition : { dsl: string, value: unknown } si présent
 *
 * Lève ValidationError si un champ requis est manquant ou mal typé.
 *
 * C'EST LA SEULE MANIÈRE de convertir du JSON en Rule.
 * Jamais JSON.parse(payload) as Rule — toujours hydrateRule(JSON.parse(payload)).
 */
export function hydrateRule(raw: Record<string, unknown>): Rule

/**
 * Version batch — appelle hydrateRule sur chaque élément.
 */
export function hydrateRules(rawRules: Record<string, unknown>[]): Rule[]
```

### Usage dans le DG (RuleStoreResolver)

```ts
class RuleStoreResolver implements RuleResolver {
  async resolve(node: DGNode, meta: ExecutionMeta): Promise<Rule[]> {
    const serialized = await this.store.resolveRules({
      model:         node.model,
      tenantId:      meta.tenantId,
      effectiveDate: meta.effectiveDate,
      country:       meta.context?.country as string
    })

    // JAMAIS : serialized.map(r => JSON.parse(r.payload) as Rule)
    // TOUJOURS :
    return serialized.map(r => hydrateRule(JSON.parse(r.payload) as Record<string, unknown>))
  }
}
```

### Usage dans le rule-registry (validatePayload)

```ts
async validatePayload(input: RuleInput): Promise<void> {
  // Étape 1 — JSON valide
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(input.payload) as Record<string, unknown>
  } catch {
    throw new RuleValidationError('payload is not valid JSON', [...])
  }

  // Étape 2 — Structure Rule valide (via hydrateRule du Core)
  // hydrateRule fait toutes les vérifications de structure
  let rule: Rule
  try {
    rule = hydrateRule(parsed)
  } catch (err) {
    throw new RuleValidationError(
      `payload does not match Rule schema: ${err instanceof Error ? err.message : String(err)}`,
      [...]
    )
  }

  // Étape 3 — Cohérence model
  if (rule.model !== input.model) {
    throw new RuleValidationError(
      `payload.model "${rule.model}" does not match rule model "${input.model}"`,
      [...]
    )
  }

  // Étape 4 — Checksum cohérent
  const expectedChecksum = computeRuleChecksum(parsed)
  if (expectedChecksum !== rule.checksum) {
    throw new RuleValidationError(
      `Checksum mismatch: expected ${expectedChecksum}, got ${rule.checksum}`,
      [...]
    )
  }
}
```

---

## 6. `computeRuleChecksum()` — intégrité des règles

```ts
/**
 * Calcule le SHA-256 d'une règle pour vérification d'intégrité.
 *
 * Le checksum est calculé sur la représentation canonique de la règle
 * (JSON avec clés triées via canonicalStringify) — SANS le champ checksum lui-même.
 *
 * Utilisé par :
 *   - Le host qui crée les règles (calcule le checksum initial)
 *   - Le rule-registry (vérifie avant stockage)
 *   - Le Core RuleValidator (vérifie avant exécution)
 *
 * CONVENTION SHA-256 PARTAGÉE :
 *   @run-iq/core et @run-iq/context-engine implémentent indépendamment SHA-256.
 *   Algorithme : SHA-256 · Input : UTF-8 · Output : hex lowercase (64 chars)
 *   Source : node:crypto — zéro dépendance tierce.
 *   Pas de @run-iq/crypto — les deux packages sont des feuilles absolues.
 */
export function computeRuleChecksum(rule: object): string
```

---

## 7. Validation à deux niveaux — stockage vs exécution

Run-IQ valide les règles à **deux moments distincts** avec des objectifs différents.
Les deux sont nécessaires — l'un ne remplace pas l'autre.

```
STOCKAGE (rule-registry)                    EXÉCUTION (Core)
───────────────────────────────────         ───────────────────────────────────
Quand : avant de persister la règle         Quand : à chaque appel evaluate()

hydrateRule()                               RuleFilter
  → structure JSON → Rule typée               → effectiveDate dans la période ?
  → champs requis présents ?                  → tags intersectent ?
  → types corrects ?                          → condition DSL évalue à true ?

computeRuleChecksum()                       RuleValidator (Core)
  → checksum cohérent ?                       → checksum toujours cohérent ?
                                              → model enregistré ? (permissif)
Cohérence métier                              → model.validateParams() ok ?
  → model du payload = model du store ?
  → effectiveFrom < effectiveUntil ?        DominanceResolver
                                              → conflits de priorité ?

NE FAIT PAS :                               NE FAIT PAS :
  ✗ Vérifier que le model existe              ✗ Vérifier la structure JSON
  ✗ Vérifier que le DSL existe                ✗ Gérer le cycle de vie
  ✗ Évaluer les conditions                    ✗ Workflow d'approbation
  ✗ Exécuter le calcul                        ✗ Audit trail
```

### Pourquoi le rule-registry ne vérifie PAS le model

Le rule-registry ne connaît pas les `ModelRegistry` ou `DSLRegistry` enregistrés.
Une règle peut référencer un model `"PROGRESSIVE_BRACKET"` qui sera enregistré au
moment de l'exécution par le plugin fiscal — mais qui n'existe pas au moment du stockage.

C'est le Core qui fait cette vérification à l'exécution :
- Model enregistré → `model.validateParams(params)`
- Model non enregistré → rule skippée avec `MODEL_NOT_FOUND` (permissif)
  ou passée au plugin via `beforeEvaluate` (meta-rules)

---

## 8. PPEEngine — signature publique pour le DG

```ts
export interface PPEEngineConfig {
  readonly plugins:             PPEPlugin[]
  readonly dsls:                DSLEvaluator[]
  readonly snapshot?:           ISnapshotAdapter | undefined
  readonly strict?:             boolean | undefined            // default: true
  readonly timeout?: {
    readonly dsl?:      number | undefined   // default: 100ms
    readonly hook?:     number | undefined   // default: 500ms
    readonly pipeline?: number | undefined   // default: undefined (no limit)
  } | undefined
  readonly onConflict?:         'throw' | 'first' | undefined  // default: 'throw' if strict
  readonly onChecksumMismatch?: 'throw' | 'skip' | undefined   // default: 'skip'
  readonly dryRun?:             boolean | undefined             // default: false
  readonly onSnapshotError?:    ((error: unknown) => void) | undefined
}

export class PPEEngine {
  constructor(config: PPEEngineConfig)

  /**
   * Évalue un ensemble de règles sur un input.
   *
   * Pipeline complet (10 étapes) :
   *   1. InputSanitizer   → validation input
   *   2. Idempotence      → requestId déjà traité ?
   *   3. beforeEvaluate   → hooks plugins (immuable)
   *   4. RuleFilter       → dates + DSL + tags
   *   5. RuleValidator    → checksums + params
   *   6. DominanceResolver → conflits priorité
   *   7. ExecutionPipeline → calculs via modèles
   *   8. TraceBuilder     → audit trail
   *   9. afterEvaluate    → hooks plugins (immuable)
   *  10. SnapshotManager  → sauvegarde obligatoire
   *
   * STATELESS : chaque appel est indépendant.
   * DÉTERMINISTE : même rules + même input = même result.
   */
  async evaluate(
    rules: ReadonlyArray<Rule>,
    input: EvaluationInput,
  ): Promise<EvaluationResult>
}
```

### Ce que le DG doit savoir sur evaluate()

- **Signature** : `evaluate(rules, input)` — les règles sont toujours passées en paramètre
- **Idempotence** : le même `requestId` retourne le snapshot existant sans recalcul
- **Le DG compose** : `nodeExecutionId = ${graphRequestId}:${nodeId}` → idempotence par nœud
- **Strict mode** : en `strict: true`, snapshot `save()` échoue → `SnapshotFailureError`
- **DryRun** : en `dryRun: true`, pas de snapshot sauvegardé
- **Plugins** : les plugins sont enregistrés au `new PPEEngine()`, pas à chaque `evaluate()`

---

## 9. Hiérarchie d'erreurs — complète

```ts
PPEError (base)
├── RuleConflictError       — deux règles même priorité, mode 'throw'
├── ModelNotFoundError      — model non enregistré (si mode strict)
├── DSLNotFoundError        — dsl non enregistré dans DSLRegistry
├── SnapshotFailureError    — save() échoue en mode strict
├── DSLTimeoutError         — évaluation DSL dépasse le timeout
├── DSLEvaluationError      — évaluateur DSL lève une erreur
├── PipelineTimeoutError    — pipeline entier dépasse le timeout
└── ValidationError         — input invalide (InputSanitizer)
```

Toutes les erreurs héritent de `PPEError` qui étend `Error` avec `Object.setPrototypeOf`
pour un safe `instanceof` check.

---

## 10. Dépendances mises à jour — graphe complet

```
@run-iq/core                → dépend de : RIEN dans Run-IQ
@run-iq/context-engine      → dépend de : RIEN dans Run-IQ
@run-iq/dsl-jsonlogic       → peer dep : @run-iq/core
@run-iq/plugin-sdk          → peer dep : @run-iq/core

@run-iq/rule-registry
├── @run-iq/context-engine  → RuleStore, SerializedRule, RuleQuery, etc.
└── @run-iq/core            → Rule (type), hydrateRule(), computeRuleChecksum()
                              UNIQUEMENT Catégorie B
                              JAMAIS PPEEngine, JAMAIS DominanceResolver

@run-iq/dg
├── @run-iq/context-engine  → EvaluationContext, PersistenceAdapter, stores interfaces
└── @run-iq/core            → PPEEngine, DSLEvaluator, Rule, EvaluationResult
                              Catégories A + B

@run-iq/plugin-fiscal
└── @run-iq/plugin-sdk      → qui réexporte tout ce dont les plugins ont besoin
                              (plugin-sdk dépend de core — pas les plugins directement)

@run-iq/server
├── @run-iq/dg              → DGOrchestrator, DGCompiler, CompiledGraph
├── @run-iq/context-engine  → PersistenceAdapter, stores interfaces
└── @run-iq/core            → PPEEngine (pour l'évaluation directe sans DG)
```

---

## 11. Résumé — ce que le Core expose pour les nouveaux packages

| Export | Catégorie | Consommateur | But |
|---|---|---|---|
| `PPEEngine` | A | dg | Exécuter des règles |
| `PPEEngineConfig` | A | dg | Configurer le moteur |
| `ModelRegistry` | A | dg, plugins | Enregistrer/chercher des modèles |
| `DSLRegistry` | A | dg, plugins | Enregistrer/chercher des DSL |
| `Rule`, `Expression` | B | dg, rule-registry, sdk | Type de règle |
| `hydrateRule()` | B | dg, rule-registry | Désérialiser JSON → Rule |
| `computeRuleChecksum()` | B | rule-registry, host | Intégrité SHA-256 |
| `PPEPlugin`, `PluginContext` | C | plugin-sdk | Abstractions plugins |
| `CalculationModel` | C | plugin-sdk | Abstractions modèles |
| `EvaluationResult` | A+B | dg, server | Résultat d'évaluation |
| `ISnapshotAdapter` | A | host | Contrat de persistence |
| Erreurs (`PPEError`, etc.) | A+B+C | tous | Hiérarchie d'erreurs |

---

*Ce document est un complément à `docs/PPE_ARCHITECTURE.md` (autorité absolue).*
*Il ne remplace aucune section de PPE_ARCHITECTURE — il documente les contrats*
*d'intégration pour les nouveaux packages de l'écosystème Run-IQ.*
