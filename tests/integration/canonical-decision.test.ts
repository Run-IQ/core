import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext } from '../../src/types/plugin.js';
import type { CalculationModel } from '../../src/types/model.js';
import type { EvaluationInput } from '../../src/types/input.js';
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
  if (typeof value === 'number') return value;
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

describe('one canonical input, one decision', () => {
  it('gives the same decision to inputs that differ only in what the canonical form erases', async () => {
    const next = generator(20260211);
    const rules = [
      makeRule({ id: 'plain', model: 'SUMS' }),
      makeRule({ id: 'tagged', model: 'SUMS', tags: ['a'], priority: 90 }),
      makeRule({ id: 'dim', model: 'SUMS', dimensions: { region: 'TG' }, priority: 80 }),
    ];
    for (let index = 0; index < 40; index += 1) {
      const data = randomJson(next, 3);
      const base = {
        data:
          typeof data === 'object' && data !== null && !Array.isArray(data) ? data : { v: data },
      };
      const tags = ['b', 'a', 'a'].slice(0, 1 + Math.floor(next() * 3));
      const regions = ['TG', 'BJ', 'TG'].slice(0, 1 + Math.floor(next() * 3));
      const input = (flip: boolean): EvaluationInput => ({
        requestId: `case-${index}-${flip ? 'b' : 'a'}`,
        data: (flip ? variant(base.data, next) : base.data) as Record<string, unknown>,
        meta: {
          tenantId: 't',
          tags: flip ? [...tags].reverse() : tags,
          dimensions: { region: flip ? [...regions].reverse() : regions },
          dates: {
            effective: flip ? new Date('2025-03-01T00:00:00.000Z') : '2025-03-01T00:00:00.000Z',
          },
          ...(flip ? { context: {}, assertions: {} } : {}),
        } as EvaluationInput['meta'],
      });
      const left = await engine().evaluate(rules, input(false));
      const right = await engine().evaluate(rules, input(true));
      expect(right.value).toBe(left.value);
      expect(right.outputs).toEqual(left.outputs);
      expect(right.appliedRules.map((rule) => rule.id)).toEqual(
        left.appliedRules.map((rule) => rule.id),
      );
      expect(right.skippedRules.map((skip) => [skip.rule.id, skip.reason])).toEqual(
        left.skippedRules.map((skip) => [skip.rule.id, skip.reason]),
      );
    }
  });
});
