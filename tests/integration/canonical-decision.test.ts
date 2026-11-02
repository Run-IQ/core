import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { EvaluationInput } from '../../src/types/input.js';
import { ValidationError } from '../../src/errors/ValidationError.js';
import { makeRule } from '../helpers.js';

// Ruling 2 of round 6: two inputs with the same canonical form give the same decision.
//
// The canonical form (`ProofInput`) sorts the keys of every object, writes `-0` as `0`, sorts and
// deduplicates the tags and the values of a dimension, writes every date by `toReferenceDate`, and
// takes `{}` for an absent `context` or `assertions`. The cases below are generated from a seed:
// each case is an input and several variants that differ only in what the canonical form erases;
// the engine must decide the same for all of them.

/** A small deterministic generator (mulberry32). */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function randomJson(next: () => number, depth: number): Json {
  const pick = next();
  if (depth <= 0 || pick < 0.45) {
    const kind = Math.floor(next() * 4);
    if (kind === 0) return Math.floor(next() * 2000) - 1000;
    if (kind === 1) return next() < 0.5 ? 0 : Math.floor(next() * 50);
    if (kind === 2) return next() < 0.5;
    return `s${Math.floor(next() * 100)}`;
  }
  if (pick < 0.65) {
    return Array.from({ length: Math.floor(next() * 4) }, () => randomJson(next, depth - 1));
  }
  const keys = Array.from(
    { length: 1 + Math.floor(next() * 4) },
    () => `k${Math.floor(next() * 8)}`,
  );
  const object: { [key: string]: Json } = {};
  for (const key of keys) object[key] = randomJson(next, depth - 1);
  return object;
}

/** The same value with the keys of every object in another order and every `0` written `-0`. */
function variant(value: Json, next: () => number): Json {
  if (Array.isArray(value)) return value.map((item) => variant(item, next));
  if (typeof value === 'number') return value === 0 && next() < 0.7 ? -0 : value;
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort(() => next() - 0.5);
  const copy: { [key: string]: Json } = {};
  for (const key of keys) copy[key] = variant(value[key] as Json, next);
  return copy;
}

/** Every number of the tree, in the order of the sorted keys: it does not depend on key order. */
function sum(value: unknown): number {
  // A `-0` that reaches a model is seen: it weighs a million, so the engine must have written it 0.
  if (typeof value === 'number') return Object.is(value, -0) ? 1_000_000 : value;
  if (Array.isArray(value)) return value.reduce((total: number, item) => total + sum(item), 0);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((total, key) => total + sum((value as Record<string, unknown>)[key]), 0);
  }
  return 0;
}

const SUMS: CalculationModel = {
  name: 'SUMS',
  version: '1.0.0',
  validateParams: () => ({ valid: true }),
  calculate: (input) => sum(input),
};
const host: PPEPlugin = {
  name: 'host',
  version: '1.0.0',
  onInit: (context: PluginContext) => context.modelRegistry.register(SUMS),
};

function engine(): PPEEngine {
  return new PPEEngine({ plugins: [host], dsls: [], strict: false });
}

const rules = [
  makeRule({ id: 'plain', model: 'SUMS' }),
  makeRule({ id: 'tagged', model: 'SUMS', tags: ['a'], priority: 90 }),
  makeRule({ id: 'dim', model: 'SUMS', dimensions: { region: 'TG' }, priority: 80 }),
];

const summary = async (input: EvaluationInput): Promise<unknown> => {
  const result = await engine().evaluate(rules, input);
  return {
    value: result.value,
    outputs: result.outputs,
    applied: result.appliedRules.map((rule) => rule.id),
    skipped: result.skippedRules.map((skip) => [skip.rule.id, skip.reason]),
  };
};

/** `base` with an `undefined` (or a hole) put in the place `where` names. */
function poisoned(base: EvaluationInput, where: number): EvaluationInput {
  const data = { ...(base.data as Record<string, unknown>) };
  const meta = { ...(base.meta as Record<string, unknown>) };
  switch (where) {
    case 0:
      data['hidden'] = undefined;
      break;
    case 1:
      data['list'] = [1, undefined];
      break;
    case 2:
      data['list'] = new Array<number>(2);
      break;
    case 3:
      meta['dimensions'] = { region: [undefined] };
      break;
    case 4:
      meta['dimensions'] = { region: ['TG', undefined] };
      break;
    case 5:
      meta['dates'] = { effective: '2025-03-01', other: undefined };
      break;
    case 6:
      meta['assertions'] = { '/x': undefined };
      break;
    case 7:
      meta['assertions'] = { '/x': { deep: [undefined] } };
      break;
    default:
      meta['tags'] = ['a', undefined];
  }
  return { ...base, data, meta } as EvaluationInput;
}

describe('one canonical input, one decision', () => {
  it('gives the same decision to inputs that differ only in what the canonical form erases', async () => {
    const next = generator(20260211);
    for (let index = 0; index < 60; index += 1) {
      const data = randomJson(next, 3);
      const body = (
        typeof data === 'object' && data !== null && !Array.isArray(data) ? data : { v: data }
      ) as { [key: string]: Json };
      // `-0` and `0` are the same number; so are the dates `2025-03-01T00:00:00.000Z` as a string
      // in `dates.effective` and as a `Date` in `effectiveDate`.
      const tags = ['b', 'a', 'a'].slice(0, 1 + Math.floor(next() * 3));
      const regions = ['TG', 'BJ', 'TG'].slice(0, 1 + Math.floor(next() * 3));
      const withDimension = next() < 0.7;
      const left: EvaluationInput = {
        requestId: `case-${index}-a`,
        data: body,
        meta: {
          tenantId: 't',
          tags,
          ...(withDimension ? { dimensions: { region: regions } } : {}),
          dates: { effective: '2025-03-01T00:00:00.000Z' },
        },
      };
      const right: EvaluationInput = {
        requestId: `case-${index}-b`,
        data: variant(body, next) as { [key: string]: Json },
        meta: {
          tenantId: 't',
          tags: [...tags].reverse(),
          ...(withDimension ? { dimensions: { region: [...regions].reverse() } } : {}),
          effectiveDate: new Date('2025-03-01T00:00:00.000Z'),
          context: {},
          assertions: {},
        } as EvaluationInput['meta'],
      };
      expect(await summary(right), `case ${index}`).toEqual(await summary(left));
    }
  });

  it('sees a minus zero as zero: the model that weighs it never does', async () => {
    const left = await summary({
      requestId: 'z-a',
      data: { n: 0 },
      meta: { tenantId: 't' },
    });
    const right = await summary({
      requestId: 'z-b',
      data: { n: -0 },
      meta: { tenantId: 't' },
    });
    expect(right).toEqual(left);
    expect((left as { value: number }).value).toBeLessThan(1000);
  });

  it('refuses, with a pointer, every input that hides an undefined or a hole, as the case without it decides', async () => {
    const next = generator(7);
    for (let index = 0; index < 54; index += 1) {
      const base: EvaluationInput = {
        requestId: `p-${index}`,
        data: { n: Math.floor(next() * 10) },
        meta: { tenantId: 't', tags: ['a'], dimensions: { region: 'TG' } },
      };
      await expect(summary(base)).resolves.toBeDefined(); // the clean input is decided
      const where = index % 9;
      const error = await engine()
        .evaluate(rules, poisoned({ ...base, requestId: `q-${index}` }, where))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error, `place ${where}`).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).reasons.join('; '), `place ${where}`).toMatch(
        /\/(data|meta)\//,
      );
    }
  });
});
