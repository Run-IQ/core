import { afterEach, describe, it, expect, vi } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import type { PPEPlugin, PluginContext, BeforeEvaluateResult } from '../../src/types/plugin.js';
import type { EvaluationResult } from '../../src/types/result.js';
import type { DSLEvaluator } from '../../src/types/dsl.js';
import type { PPEEngineConfig } from '../../src/engine/PPEEngine.js';
import { PipelineTimeoutError, UnexpectedEngineError } from '../../src/index.js';
import { makeRule, makeInput, StubModel, StubDSL, InMemorySnapshotAdapter } from '../helpers.js';

// These plugins break the hook contract on purpose, the way untyped JavaScript plugins can.

const host: PPEPlugin = {
  name: 'model-host',
  version: '1.0.0',
  onInit(context: PluginContext): void {
    context.modelRegistry.register(new StubModel('M', 100));
  },
};

function pluginWith(name: string, hooks: Partial<PPEPlugin>): PPEPlugin {
  return { name, version: '1.0.0', onInit: () => undefined, ...hooks };
}

function engineWith(
  plugins: PPEPlugin[],
  config: Partial<PPEEngineConfig> = {},
  dsls: DSLEvaluator[] = [],
): PPEEngine {
  return new PPEEngine({ plugins: [host, ...plugins], dsls, strict: false, ...config });
}

/** Builds the value a hook returns without the types' help, as untyped code would. */
function untyped<T>(value: unknown): T {
  // justification: hostile plugins return values outside the hook types on purpose.
  return value as T;
}

const rule = () => makeRule({ id: 'r1', model: 'M' });

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('hostile thrown values', () => {
  const thrown: [string, () => unknown, string][] = [
    ['a number', () => 42, '42'],
    ['a symbol', () => Symbol('s'), 'Symbol(s)'],
    ['a null-prototype object', () => Object.create(null), '(unprintable error)'],
    ['a revoked proxy', revokedProxy, '(unprintable error)'],
    [
      'a proxy whose getPrototypeOf throws',
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('trap');
            },
          },
        ),
      '(unprintable error)',
    ],
  ];
  for (const hook of ['beforeEvaluate', 'afterEvaluate'] as const) {
    for (const [label, make, message] of thrown) {
      it(`${hook} throwing ${label} becomes a diagnostic and a wrapped onError`, async () => {
        const onError = vi.fn();
        const value = make();
        const bad = pluginWith('bad', {
          [hook]: () => {
            throw value;
          },
          onError,
        });
        const result = await engineWith([bad]).evaluate([rule()], makeInput());
        expect(result.value).toBe(100);
        expect(result.diagnostics).toEqual([{ source: 'hook', plugin: 'bad', hook, message }]);
        const error: unknown = onError.mock.calls[0]?.[0];
        expect(error).toBeInstanceOf(UnexpectedEngineError);
        // Compared by identity: printing or deep-comparing a hostile proxy would throw.
        expect(error instanceof UnexpectedEngineError && error.cause === value).toBe(true);
      });
    }
  }
});

describe('hostile beforeEvaluate results', () => {
  const cases: [string, (result: BeforeEvaluateResult) => unknown, string][] = [
    ['undefined', () => undefined, 'returned undefined, not a result; ignored'],
    ['{}', () => ({}), 'returned a malformed input; ignored'],
    ['an input without rules', (r) => ({ input: r.input }), 'returned a malformed rules; ignored'],
    ['rules: 5', (r) => ({ input: r.input, rules: 5 }), 'returned a malformed rules; ignored'],
    ['rules: [5]', (r) => ({ input: r.input, rules: [5] }), 'returned a malformed rules; ignored'],
    ['skipped: 5', (r) => ({ ...r, skipped: 5 }), 'returned a malformed skipped; ignored'],
    [
      'a skip without a rule object',
      (r) => ({ ...r, skipped: [{ rule: 5, reason: 'X' }] }),
      'returned a malformed skipped; ignored',
    ],
    [
      'a skip without a string reason',
      (r) => ({ ...r, skipped: [{ rule: r.rules[0], reason: 5 }] }),
      'returned a malformed skipped; ignored',
    ],
    [
      'data that is not an object',
      (r) => ({ ...r, input: { ...r.input, data: 5 } }),
      'returned a malformed input; ignored',
    ],
    [
      'a state getter that throws',
      (r) => {
        const out = { ...r };
        Object.defineProperty(out, 'state', {
          enumerable: true,
          get() {
            throw new Error('state getter');
          },
        });
        return out;
      },
      'state getter',
    ],
  ];
  for (const [label, make, message] of cases) {
    it(`commits nothing for ${label}`, async () => {
      const onError = vi.fn();
      const bad = pluginWith('bad', {
        beforeEvaluate: (input, _rules) =>
          untyped<BeforeEvaluateResult>(
            make({ input: { ...input, data: { ...input.data, marked: true } }, rules: [] }),
          ),
        onError,
      });
      let seen: unknown;
      const reader = pluginWith('reader', {
        beforeEvaluate(input, rules): BeforeEvaluateResult {
          seen = input.data['marked'];
          return { input, rules };
        },
      });
      const result = await engineWith([bad, reader]).evaluate([rule()], makeInput());
      expect(result.value).toBe(100);
      expect(seen).toBeUndefined();
      expect(result.pluginState).toEqual({});
      const expected =
        message === 'state getter' ? message : `plugin bad beforeEvaluate ${message}`;
      expect(result.diagnostics).toEqual([
        { source: 'hook', plugin: 'bad', hook: 'beforeEvaluate', message: expected },
      ]);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  }

  it('reads the state once: a getter cannot pass the JSON check and then return a Date', async () => {
    let reads = 0;
    const st = pluginWith('st', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        const state = {};
        Object.defineProperty(state, 'x', {
          enumerable: true,
          get: () => (reads++ === 0 ? 1 : new Date(0)),
        });
        return { input, rules, state };
      },
    });
    const result = await engineWith([st]).evaluate([rule()], makeInput());
    expect(result.pluginState).toEqual({ st: { x: 1 } });
    expect(result.diagnostics).toEqual([]);
  });

  it('gives a plugin skip without detail the detail "skipped by plugin <name>"', async () => {
    const fiscal = pluginWith('fiscal', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: [],
        skipped: rules.map((r) => ({ rule: r, reason: 'SHORT_CIRCUITED' as const })),
      }),
    });
    const result = await engineWith([fiscal]).evaluate([rule()], makeInput());
    expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
      ['r1', 'SHORT_CIRCUITED', 'skipped by plugin fiscal'],
    ]);
  });
});

describe('hostile afterEvaluate results', () => {
  for (const [returned, described] of [
    [undefined, 'undefined'],
    [null, 'null'],
    [42, '42'],
    ['str', '"str"'],
  ] as const) {
    it(`ignores a result that is ${described}`, async () => {
      const bad = pluginWith('bad', { afterEvaluate: () => untyped<EvaluationResult>(returned) });
      const result = await engineWith([bad]).evaluate([rule()], makeInput());
      expect(result.value).toBe(100);
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        `plugin bad afterEvaluate returned ${described}, not a result; ignored`,
      ]);
    });
  }

  it('ignores a result whose appliedRules is not an array of objects', async () => {
    const bad = pluginWith('bad', {
      afterEvaluate: (_input, result) =>
        untyped<EvaluationResult>({ ...result, appliedRules: [5] }),
    });
    const result = await engineWith([bad]).evaluate([rule()], makeInput());
    expect(result.appliedRules.map((r) => r.id)).toEqual(['r1']);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'plugin bad afterEvaluate returned a malformed appliedRules; ignored',
    ]);
  });

  it('reads value once: a getter answering 7, 7, then "evil" leaves value and outputs in sync', async () => {
    let reads = 0;
    const bad = pluginWith('bad', {
      afterEvaluate(_input, result): EvaluationResult {
        const out = { ...result };
        Object.defineProperty(out, 'value', {
          enumerable: true,
          get: () => (reads++ < 2 ? 7 : 'evil'),
        });
        return out;
      },
    });
    const result = await engineWith([bad]).evaluate([rule()], makeInput());
    expect(result.value).toBe(7);
    expect(result.outputs['value']!.value).toBe(7);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'plugin bad rewrote output value from 100 to 7',
    ]);
  });

  it('reads appliedRules once: a proxy cannot show one list to the check and another to the result', async () => {
    let reads = 0;
    const bad = pluginWith('bad', {
      afterEvaluate: (_input, result) =>
        new Proxy(result, {
          get(target, key) {
            if (key !== 'appliedRules') return Reflect.get(target, key);
            return reads++ === 0
              ? target.appliedRules
              : [...target.appliedRules, { id: 'HIDDEN', model: 'X' }];
          },
        }),
    });
    const result = await engineWith([bad]).evaluate([rule()], makeInput());
    expect(result.appliedRules.map((r) => r.id)).toEqual(['r1']);
    expect(result.diagnostics).toEqual([]);
  });

  it('ignores every engine-owned field a plugin edits, in one diagnostic', async () => {
    const st = pluginWith('st', {
      beforeEvaluate: (input, rules) => ({ input, rules, state: { a: 1 } }),
    });
    // A careless plugin writing through the readonly types.
    interface Writable {
      pluginState: Record<string, { a: number }>;
      diagnostics: unknown[];
      pluginVersions: Record<string, string>;
      missingFacts: string[];
      dslVersions: Record<string, string>;
    }
    const bad = pluginWith('bad', {
      afterEvaluate(_input, result): EvaluationResult {
        const writable = untyped<Writable>(result);
        writable.pluginState['st']!.a = 999;
        writable.diagnostics.push({ source: 'engine', message: 'forged' });
        writable.pluginVersions['model-host'] = '6.6.6';
        writable.missingFacts.push('ghost');
        writable.dslVersions['fake'] = '1';
        return result;
      },
    });
    const result = await engineWith([st, bad]).evaluate([rule()], makeInput());
    expect(result.pluginState).toEqual({ st: { a: 1 } });
    expect(result.pluginVersions).toEqual({ 'model-host': '1.0.0', st: '1.0.0', bad: '1.0.0' });
    expect(result.missingFacts).toEqual([]);
    expect(result.dslVersions).toEqual({});
    expect(result.diagnostics).toEqual([
      {
        source: 'hook',
        plugin: 'bad',
        hook: 'afterEvaluate',
        message:
          'plugin bad changed engine-owned fields diagnostics, dslVersions, missingFacts, ' +
          'pluginState, pluginVersions; ignored',
      },
    ]);
  });

  it('names applied and skipped entries kept under the same id but changed', async () => {
    const bad = pluginWith('bad', {
      afterEvaluate: (_input, result) => ({
        ...result,
        appliedRules: result.appliedRules.map((r) => ({ ...r, version: 99 })),
        skippedRules: result.skippedRules.map((s) => ({
          ...s,
          reason: 'DOMINATED' as const,
          detail: 'forged',
        })),
      }),
    });
    const result = await engineWith([bad], {}, [new StubDSL('never', false)]).evaluate(
      [rule(), makeRule({ id: 'x', model: 'M', condition: { dsl: 'never', value: null } })],
      makeInput(),
    );
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'plugin bad changed applied rules: r1',
      'plugin bad changed skipped rules: x',
    ]);
  });

  it('accepts the fiscal transition: value, pseudo applied rule, trace and meta', async () => {
    const fiscal = pluginWith('fiscal', {
      afterEvaluate: (_input, result) => ({
        ...result,
        value: 0,
        appliedRules: [
          ...result.appliedRules,
          untyped<EvaluationResult['appliedRules'][number]>({
            id: 'SC',
            model: 'META_SHORT_CIRCUIT',
            priority: 9999,
          }),
        ],
        trace: { ...result.trace, steps: [...result.trace.steps] },
        meta: { fiscalBreakdown: { unknown: 100 } },
      }),
    });
    const result = await engineWith([fiscal]).evaluate([rule()], makeInput());
    expect(result.value).toBe(0);
    expect(result.outputs['value']!.value).toBe(0);
    expect(result.appliedRules.map((r) => r.id)).toEqual(['r1', 'SC']);
    expect(result.meta).toEqual({ fiscalBreakdown: { unknown: 100 } });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'plugin fiscal rewrote output value from 100 to 0',
      'plugin fiscal added applied rules: SC',
    ]);
  });
});

describe('pipeline timeout abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the late pipeline: no afterEvaluate, no save, no onError', async () => {
    const adapter = new InMemorySnapshotAdapter();
    const save = vi.spyOn(adapter, 'save');
    const afterEvaluate = vi.fn((_input: unknown, result: EvaluationResult) => result);
    const onError = vi.fn();
    let release: () => void = () => undefined;
    const slow = pluginWith('slow', {
      beforeEvaluate: (input, rules) =>
        new Promise<BeforeEvaluateResult>((resolve) => {
          release = () => resolve({ input, rules });
        }),
      afterEvaluate,
      onError,
    });
    const engine = engineWith([slow], {
      timeout: { hook: 10_000, pipeline: 20 },
      snapshot: adapter,
    });
    await expect(engine.evaluate([rule()], makeInput())).rejects.toThrow(PipelineTimeoutError);
    release();
    // Lets the late pipeline run to its end.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(afterEvaluate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('fields read by name', () => {
  it('keeps a non-enumerable state', async () => {
    const p = pluginWith('p', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        const out: BeforeEvaluateResult = { input, rules };
        Object.defineProperty(out, 'state', { value: { a: 1 } });
        return out;
      },
    });
    const result = await engineWith([p]).evaluate([rule()], makeInput());
    expect(result.pluginState).toEqual({ p: { a: 1 } });
  });

  it('uses a non-enumerable skipped', async () => {
    const p = pluginWith('p', {
      beforeEvaluate(input, rules): BeforeEvaluateResult {
        const out: BeforeEvaluateResult = { input, rules: [] };
        Object.defineProperty(out, 'skipped', {
          value: rules.map((r) => ({ rule: r, reason: 'SHORT_CIRCUITED' })),
        });
        return out;
      },
    });
    const result = await engineWith([p]).evaluate([rule()], makeInput());
    expect(result.skippedRules.map((s) => [s.rule.id, s.reason, s.detail])).toEqual([
      ['r1', 'SHORT_CIRCUITED', 'skipped by plugin p'],
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts a class result whose fields are prototype getters, reading each once', async () => {
    const reads: string[] = [];
    class Result implements BeforeEvaluateResult {
      constructor(
        private readonly given: BeforeEvaluateResult['input'],
        private readonly source: BeforeEvaluateResult['rules'],
      ) {}
      get input(): BeforeEvaluateResult['input'] {
        reads.push('input');
        return this.given;
      }
      get rules(): BeforeEvaluateResult['rules'] {
        reads.push('rules');
        return [];
      }
      get skipped(): BeforeEvaluateResult['skipped'] {
        reads.push('skipped');
        return this.source.map((r) => ({ rule: r, reason: 'SHORT_CIRCUITED' as const }));
      }
      get state(): BeforeEvaluateResult['state'] {
        reads.push('state');
        return { cls: true };
      }
    }
    const p = pluginWith('p', { beforeEvaluate: (input, rules) => new Result(input, rules) });
    const result = await engineWith([p]).evaluate([rule()], makeInput());
    expect(reads.sort()).toEqual(['input', 'rules', 'skipped', 'state']);
    expect(result.pluginState).toEqual({ p: { cls: true } });
    expect(result.skippedRules.map((s) => s.rule.id)).toEqual(['r1']);
    expect(result.appliedRules).toEqual([]);
  });

  it('keeps a non-enumerable meta and reads each afterEvaluate field once', async () => {
    const reads = new Map<string, number>();
    const p = pluginWith('p', {
      afterEvaluate(_input, result): EvaluationResult {
        const out = { ...result };
        for (const key of [
          'value',
          'appliedRules',
          'skippedRules',
          'trace',
          'breakdown',
        ] as const) {
          const current: unknown = out[key];
          Object.defineProperty(out, key, {
            enumerable: true,
            get: () => {
              reads.set(key, (reads.get(key) ?? 0) + 1);
              return current;
            },
          });
        }
        Object.defineProperty(out, 'meta', { value: { m: 1 } });
        return out;
      },
    });
    const result = await engineWith([p]).evaluate([rule()], makeInput());
    expect(result.meta).toEqual({ m: 1 });
    expect(Object.fromEntries(reads)).toEqual({
      value: 1,
      appliedRules: 1,
      skippedRules: 1,
      trace: 1,
      breakdown: 1,
    });
    expect(result.diagnostics).toEqual([]);
  });
});

describe('trace and breakdown shapes', () => {
  for (const [label, change, field] of [
    ['trace.steps: 5', { trace: { steps: 5 } }, 'trace'],
    ['trace.steps: [5]', { trace: { steps: [5] } }, 'trace'],
    ['breakdown: [null, 5]', { breakdown: [null, 5] }, 'breakdown'],
  ] as const) {
    it(`ignores a result with ${label}`, async () => {
      const bad = pluginWith('bad', {
        afterEvaluate: (_input, result) => untyped<EvaluationResult>({ ...result, ...change }),
      });
      const result = await engineWith([bad]).evaluate([rule()], makeInput());
      expect(result.trace.steps).toHaveLength(1);
      expect(result.breakdown).toHaveLength(1);
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        `plugin bad afterEvaluate returned a malformed ${field}; ignored`,
      ]);
    });
  }
});

describe('rules removed without a skip', () => {
  it('names them, by id then version', async () => {
    const p = pluginWith('p', {
      beforeEvaluate: (input, rules) => ({
        input,
        rules: rules.filter((r) => r.id === 'keep'),
        skipped: rules
          .filter((r) => r.id === 'listed')
          .map((r) => ({ rule: r, reason: 'SHORT_CIRCUITED' as const })),
      }),
    });
    const result = await engineWith([p]).evaluate(
      [
        makeRule({ id: 'b', model: 'M', version: 2 }),
        makeRule({ id: 'keep', model: 'M' }),
        makeRule({ id: 'listed', model: 'M' }),
        makeRule({ id: 'b', model: 'M', version: 1 }),
        makeRule({ id: 'a', model: 'M' }),
      ],
      makeInput(),
    );
    expect(result.diagnostics).toEqual([
      {
        source: 'hook',
        plugin: 'p',
        hook: 'beforeEvaluate',
        message: 'plugin p removed rules without a skip: a@1, b@1, b@2',
      },
    ]);
  });
});

describe('hook timer on abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the in-flight hook timer when the pipeline times out', async () => {
    vi.useFakeTimers();
    const hang = pluginWith('hang', {
      beforeEvaluate: () => new Promise<BeforeEvaluateResult>(() => undefined),
    });
    const engine = engineWith([hang], { timeout: { hook: 10_000, pipeline: 20 } });
    const outcome = engine.evaluate([rule()], makeInput());
    const settled = expect(outcome).rejects.toThrow(PipelineTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await settled;
    expect(vi.getTimerCount()).toBe(0);
  });
});
