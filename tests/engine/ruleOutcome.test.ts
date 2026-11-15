import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CAUSES as specCauses } from '@run-iq/spec';
import * as core from '../../src/index.js';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

describe('R2: one list of causes', () => {
  it("core re-exports spec's ERROR_CAUSES, the same frozen object", () => {
    expect(core.ERROR_CAUSES).toBe(specCauses);
    expect(Object.isFrozen(core.ERROR_CAUSES)).toBe(true);
    expect(core.ERROR_CAUSES.length).toBeGreaterThan(0);
  });
});

describe('R9 and ruling 22: the deprecated reasons and the removed one', () => {
  const source = readFileSync(join(process.cwd(), 'src/types/result.ts'), 'utf8');
  const block = (reason: string): string => {
    const at = source.indexOf(`| '${reason}'`);
    expect(at, `${reason} is in SkipReason`).toBeGreaterThan(-1);
    return source.slice(source.lastIndexOf('/**', at), at);
  };

  for (const reason of [
    'DSL_ERROR',
    'DSL_NOT_FOUND',
    'INVALID_PARAMS',
    'CHECKSUM_MISMATCH',
    'INVALID_RULE',
    'OUTPUT_MISMATCH',
    'MODEL_ERROR',
  ]) {
    it(`${reason} stays for plugins, marked deprecated: core reports a pending ERROR`, () => {
      expect(block(reason)).toContain('@deprecated core reports it as a pending ERROR');
    });
  }

  it('CONDITION_TIMEOUT is removed (ruling 22): no backward compatibility', () => {
    expect(source).not.toContain('CONDITION_TIMEOUT');
  });

  it('the reasons that stay are not deprecated', () => {
    for (const reason of [
      'INACTIVE_DATE',
      'CONDITION_FALSE',
      'TAG_MISMATCH',
      'PLUGIN',
      'INHIBITED',
    ]) {
      expect(block(reason)).not.toContain('@deprecated');
    }
  });
});

describe('R4, written for the hand-back of PPEEngine.ts (it.fails flips when the engine is changed)', () => {
  const engine = (): PPEEngine =>
    new PPEEngine({
      plugins: [
        {
          name: 'h',
          version: '1.0.0',
          onInit: (c) => c.modelRegistry.register(new StubModel('m', 5)),
        },
      ],
      dsls: [],
      strict: false,
      snapshot: new InMemorySnapshotAdapter(),
    });

  // R4: every result carries `pendingRules` and `readsUndeclared`, frozen. The engine does not fill
  // them yet: PPEEngine.ts is not touched until the machine session hands it back. Remove `.fails`
  // when the two lists are set where the result is built.
  it.fails(
    'R4: the result has pendingRules and readsUndeclared, both frozen and empty',
    async () => {
      const result = await engine().evaluate([makeRule({ id: 'a', model: 'm' })], makeInput());
      expect(result.pendingRules).toEqual([]);
      expect(result.readsUndeclared).toEqual([]);
      expect(Object.isFrozen(result.pendingRules)).toBe(true);
      expect(Object.isFrozen(result.readsUndeclared)).toBe(true);
    },
  );
});
