# Phase 2 changes in core

This document is owned by the lane that works in core. The `phase-2-changes` text of `@run-iq/spec`
links here and is not edited from core.

## Threat model of the plugin boundary

The boundary sits between the engine and plugin code (hooks, models, DSLs).

- It protects data, completely: the caller's input and rules, the ledger of the rules that were
  given, the per-evaluation snapshot of the registries, every value a model or a DSL returns, the
  decision, the record, and the error the caller receives. Plugin code changes none of them except
  through the documented channels: what a hook returns and what a model or a DSL returns, each read
  once and checked.
- It does not isolate code from other code in one JavaScript realm. One plugin changing another
  plugin's closure, its `this` state or its prototype, or patching globals, is out of the engine's
  reach (probes Vf, Vf3, Vj). Installing an in-process plugin means trusting its code.
- Phase 3 answers that: a `sandbox` (out of process or in a separate realm, with no network and no
  disk, bounded time and memory, only JSON crossing it), signed loading with a default trust list,
  capture of the intrinsics by core before any plugin, and the identity of each plugin that ran
  (name, version, code digest, signing key, mode) in the proof.

## Models and DSLs receive strings

The engine holds no `Date`. Every date in a rule (`effectiveFrom`, `effectiveUntil`, `params`,
`condition.value`, extension fields) is converted at entry to its canonical instant string, with the
checksum unchanged, and an invalid `Date` is refused with its pointer. Models and DSLs receive those
strings and write-trapping views, never a `Date` object.

## Open items for later tasks

- G-1 bench figure (D-26): measured by the bench task; no figure is claimed by 9L.
- D-39: a rule whose reads are unknown (a DSL or model without `listVariables`, or a failing one) is
  reported with `declared: false` and a diagnostic. It is still evaluated in 9L; the `provisional`
  status is 9M1's. `FiscalPlugin.beforeEvaluate` meta-rules depend on it.
- The seven inert limits (`maxInstances`, `maxCollectionLength`, `maxStrata`, `maxSegments`,
  `maxRecursionDepth`, `maxReferentialNodes`, `maxGroupDepth`) are enforced by their own tasks.
