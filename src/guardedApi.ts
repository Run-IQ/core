import { ModelRegistry as InternalModelRegistry } from './registry/ModelRegistry.js';
import { DSLRegistry as InternalDSLRegistry } from './registry/DSLRegistry.js';
import {
  hydrateRule as hydrateRuleImpl,
  hydrateRules as hydrateRulesImpl,
} from './utils/hydrate.js';
import { canonicalStringify as canonicalStringifyImpl } from './utils/json.js';
import {
  hashParams as hashParamsImpl,
  computeRuleChecksum as computeRuleChecksumImpl,
} from './utils/crypto.js';
import { resolveLimits as resolveLimitsImpl } from './limits.js';
import {
  normalizeMeta as normalizeMetaImpl,
  evaluationDate as evaluationDateImpl,
} from './input/normalizeMeta.js';
import { readsOf as readsOfImpl } from './context/reads.js';
import { buildContext as buildContextImpl } from './context/buildContext.js';
import { formatPointer as formatPointerImpl, parsePointer as parsePointerImpl } from '@run-iq/spec';
import { guard, guardMethods } from './errors/guard.js';

/**
 * The functions and classes the package exports, as callers use them. Each throws engine errors
 * only (frozen, from the exported classes): a bad argument is a `ValidationError` naming the
 * function, never a raw `TypeError`, `Error` or `SpecError` (AI7). The engine's own code calls the
 * unguarded implementations, so that its hot paths pay nothing.
 */
export const hydrateRule = guard('hydrateRule', hydrateRuleImpl, true);
export const hydrateRules = guard('hydrateRules', hydrateRulesImpl, true);
export const canonicalStringify = guard('canonicalStringify', canonicalStringifyImpl, true);
export const hashParams = guard('hashParams', hashParamsImpl, true);
export const computeRuleChecksum = guard('computeRuleChecksum', computeRuleChecksumImpl, true);
export const resolveLimits = guard('resolveLimits', resolveLimitsImpl, true);
export const normalizeMeta = guard('normalizeMeta', normalizeMetaImpl, true);
export const evaluationDate = guard('evaluationDate', evaluationDateImpl, true);
export const readsOf = guard('readsOf', readsOfImpl);
export const buildContext = guard('buildContext', buildContextImpl, true);
export const formatPointer = guard('formatPointer', formatPointerImpl, true);
export const parsePointer = guard('parsePointer', parsePointerImpl, true);

class ModelRegistry extends InternalModelRegistry {}
class DSLRegistry extends InternalDSLRegistry {}
guardMethods(ModelRegistry, ['register', 'describe', 'describeAll', 'get', 'has', 'getAll']);
guardMethods(DSLRegistry, [
  'register',
  'describe',
  'describeAll',
  'get',
  'has',
  'getAll',
  'versions',
]);
Object.defineProperty(ModelRegistry, 'name', { value: 'ModelRegistry' });
Object.defineProperty(DSLRegistry, 'name', { value: 'DSLRegistry' });
export { ModelRegistry, DSLRegistry };
