import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { CallbackError } from '../../src/errors/CallbackError.js';
import { SnapshotFailureError } from '../../src/errors/SnapshotFailureError.js';
import { makeRule, makeInput, StubModel, InMemorySnapshotAdapter } from '../helpers.js';

// AI2: every callback the caller gives the engine is synchronous, like the plugin hooks. A thenable
// it returns is a named engine error, never awaited, and its rejection is handled before the
// refusal, so that no unhandled rejection can occur (the host process would die after the
// evaluation succeeded). AI5: `exists` answers true or false.

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const host = {
  name: 'host',
  version: '1.0.0',
  onInit: (context: { modelRegistry: { register(m: StubModel): void } }) =>
    context.modelRegistry.register(new StubModel('tax', 10)),
} as never;
const rules = [makeRule({ id: 'tax', model: 'tax' })];

const failingAdapter = (): InMemorySnapshotAdapter => {
  const adapter = new InMemorySnapshotAdapter();
  adapter.shouldFail = true;
  return adapter;
};

describe('AI2: onSnapshotError is synchronous', () => {
  for (const [label, make] of [
    [
      'an async function that rejects',
      () => async (): Promise<void> => Promise.reject(new Error('logger down')),
    ],
    [
      'a thenable that rejects',
      () => (): unknown => ({
        then: (_ok: unknown, no: (e: unknown) => void) => no(new Error('thenable down')),
      }),
    ],
    ['a promise that rejects', () => (): Promise<never> => Promise.reject(new Error('late'))],
  ] as const) {
    it(`${label}: a CallbackError, and no unhandled rejection`, async () => {
      const engine = new PPEEngine({
        plugins: [host],
        dsls: [],
        strict: false,
        snapshot: failingAdapter(),
        onSnapshotError: make() as never,
      });
      const error = await engine.evaluate(rules, makeInput()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CallbackError);
      expect(error).toMatchObject({ callback: 'onSnapshotError' });
      expect((error as Error).message).toContain('returned a promise');
      await settle();
      expect(unhandled).toEqual([]);
    });
  }

  it('a callback that returns nothing keeps the lenient behaviour', async () => {
    const seen: unknown[] = [];
    const engine = new PPEEngine({
      plugins: [host],
      dsls: [],
      strict: false,
      snapshot: failingAdapter(),
      onSnapshotError: (error) => void seen.push(error),
    });
    await engine.evaluate(rules, makeInput());
    expect(seen).toHaveLength(1);
  });
});

describe('AI2: inputSeed.derive is synchronous', () => {
  for (const [label, derive] of [
    [
      'an async function that rejects',
      async (): Promise<Uint8Array> => Promise.reject(new Error('kms down')),
    ],
    ['an async function that resolves', async (): Promise<Uint8Array> => new Uint8Array(32)],
    [
      'a thenable that rejects',
      (): unknown => ({ then: (_ok: unknown, no: (e: unknown) => void) => no(new Error('kms')) }),
    ],
    [
      'a thenable that resolves to a rejected promise',
      (): unknown => ({
        then: (ok: (v: unknown) => void) => ok(Promise.reject(new Error('inner kms'))),
      }),
    ],
  ] as const) {
    it(`${label}: a CallbackError, and no unhandled rejection`, async () => {
      const engine = new PPEEngine({
        plugins: [host],
        dsls: [],
        strict: false,
        inputSeed: { derive: derive as never },
      });
      const error = await engine.evaluate(rules, makeInput()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CallbackError);
      expect(error).toMatchObject({ callback: 'inputSeed.derive' });
      await settle();
      expect(unhandled).toEqual([]);
    });
  }

  it('AI3: a huge message, a trap object and a throwing getter are bounded text, nothing converted', async () => {
    const calls: string[] = [];
    const trap = {
      toString: () => (calls.push('toString'), 'x'),
      [Symbol.toPrimitive]: () => (calls.push('toPrimitive'), 'x'),
    };
    const getter = Object.defineProperty(new Error('x'), 'message', {
      get() {
        throw new Error('getter ran');
      },
    });
    for (const thrown of [new Error('m'.repeat(200_000)), trap, getter]) {
      const engine = new PPEEngine({
        plugins: [host],
        dsls: [],
        strict: false,
        inputSeed: {
          derive: () => {
            throw thrown;
          },
        },
      });
      const error = (await engine.evaluate(rules, makeInput()).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(CallbackError);
      expect(error.message.length).toBeLessThan(1300);
      expect((error as { cause: { message: string } }).cause.message.length).toBeLessThanOrEqual(
        1100,
      );
      expect(Object.isFrozen(error)).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});

describe('AI5: exists answers true or false', () => {
  for (const [label, answer] of [
    ['undefined', undefined],
    ['null', null],
    ['1', 1],
    ["'yes'", 'yes'],
    ["'false'", 'false'],
    ['an object', {}],
  ] as const) {
    it(`an answer of ${label} is a SnapshotFailureError, not "not seen"`, async () => {
      const adapter = new InMemorySnapshotAdapter();
      adapter.exists = (() => Promise.resolve(answer)) as never;
      const engine = new PPEEngine({ plugins: [host], dsls: [], strict: false, snapshot: adapter });
      const error = await engine.evaluate(rules, makeInput()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SnapshotFailureError);
      expect((error as Error).message).toBe('Snapshot exists check failed');
      expect(JSON.stringify((error as { cause: unknown }).cause)).toContain(
        'exists must resolve to true or false',
      );
    });
  }

  it('true and false are the two answers (true is a duplicate request)', async () => {
    const adapter = new InMemorySnapshotAdapter();
    const engine = new PPEEngine({ plugins: [host], dsls: [], strict: false, snapshot: adapter });
    await engine.evaluate(rules, makeInput());
    await expect(engine.evaluate(rules, makeInput())).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
    });
  });
});

describe('AI2: the host process survives (exit code 0)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai2-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('an async onSnapshotError that rejects does not kill the process after evaluate', () => {
    const bundle = join(dir, 'core.mjs');
    buildSync({
      entryPoints: [join(process.cwd(), 'src/index.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent',
    });
    const script = join(dir, 'run.mjs');
    writeFileSync(
      script,
      `import { PPEEngine, computeRuleChecksum } from './core.mjs';
const model = { name: 'tax', version: '1.0.0', validateParams: () => ({ valid: true }), calculate: () => 1 };
const base = { id: 'tax', version: 1, model: 'tax', params: {}, priority: 1, effectiveFrom: '2024-01-01T00:00:00.000Z', effectiveUntil: null, tags: [] };
const rule = { ...base, checksum: computeRuleChecksum(base) };
const adapter = { exists: async () => false, save: async () => { throw new Error('disk'); } };
const make = (onSnapshotError, inputSeed) => new PPEEngine({
  plugins: [{ name: 'host', version: '1.0.0', onInit: (c) => c.modelRegistry.register(model) }],
  dsls: [], strict: false, snapshot: adapter, onSnapshotError, inputSeed,
});
const input = { requestId: 'r1', data: {}, meta: { tenantId: 't' } };
const thenable = () => ({ then: (_ok, no) => no(new Error('thenable down')) });
const resolvingToRejected = () => ({ then: (ok) => ok(Promise.reject(new Error('inner down'))) });
for (const engine of [
  make(async () => { throw new Error('logger down'); }),
  make(undefined, { derive: async () => { throw new Error('kms down'); } }),
  make(thenable),
  make(resolvingToRejected),
  make(undefined, { derive: thenable }),
  make(undefined, { derive: resolvingToRejected }),
]) {
  try { await engine.evaluate([rule], input); console.log('resolved'); } catch (e) { console.log(e.name); }
}
await new Promise((r) => setTimeout(r, 50));
console.log('alive');
`,
    );
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim().split('\n')).toEqual([...Array(6).fill('CallbackError'), 'alive']);
    expect(run.status).toBe(0);
  });
});
