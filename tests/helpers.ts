import { expect } from 'vitest';
import { computeRuleChecksum } from '../src/utils/crypto.js';
import type { Rule } from '../src/types/rule.js';
import type { EvaluationInput } from '../src/types/input.js';
import type { OutputDeclaration } from '@run-iq/spec';
import type { CalculationModel, CalculationOutput, ValidationResult } from '../src/types/model.js';
import type { OutputValue } from '../src/types/output.js';
import type { DSLEvaluator } from '../src/types/dsl.js';
import type { ISnapshotAdapter, Snapshot } from '../src/types/snapshot.js';
import type { PPEPlugin, PluginContext } from '../src/types/plugin.js';

export function makeRule(overrides: Partial<Rule> & { id: string; model: string }): Rule {
  const params = overrides.params ?? {};
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { checksum: _discarded, ...cleanOverrides } = overrides;
  const ruleWithoutChecksum = {
    version: 1,
    priority: 100,
    effectiveFrom: new Date('2024-01-01'),
    effectiveUntil: null,
    tags: [],
    params,
    ...cleanOverrides,
  };
  const checksum = computeRuleChecksum(ruleWithoutChecksum as Record<string, unknown>);
  return {
    ...ruleWithoutChecksum,
    checksum,
  } as Rule;
}

export function makeInput(overrides?: Partial<EvaluationInput>): EvaluationInput {
  return {
    requestId: 'test-request-001',
    data: { amount: 1000000 },
    meta: { tenantId: 'tenant-1' },
    ...overrides,
  };
}

export class StubModel implements CalculationModel {
  readonly name: string;
  readonly version = '1.0.0';

  constructor(
    name: string,
    private readonly result: number = 100,
  ) {
    this.name = name;
  }

  validateParams(_params: unknown): ValidationResult {
    return { valid: true };
  }

  calculate(
    _input: Record<string, unknown>,
    _matchedRule: Readonly<Rule>,
    _params: unknown,
  ): number {
    return this.result;
  }
}

export class StubDSL implements DSLEvaluator {
  readonly dsl: string;
  readonly version = '1.0.0';

  constructor(
    name: string,
    private readonly result: boolean = true,
  ) {
    this.dsl = name;
  }

  evaluate(_expression: unknown, _context: Record<string, unknown>): boolean {
    return this.result;
  }
}

export class InMemorySnapshotAdapter implements ISnapshotAdapter {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly requestIds = new Set<string>();
  shouldFail = false;

  async save(snapshot: Snapshot): Promise<string> {
    if (this.shouldFail) {
      throw new Error('Snapshot save failed');
    }
    this.snapshots.set(snapshot.id, snapshot);
    this.requestIds.add(snapshot.requestId);
    return snapshot.id;
  }

  async get(snapshotId: string): Promise<Snapshot> {
    const s = this.snapshots.get(snapshotId);
    if (!s) throw new Error(`Snapshot ${snapshotId} not found`);
    return s;
  }

  async exists(requestId: string): Promise<boolean> {
    return this.requestIds.has(requestId);
  }
}

export class StubPlugin implements PPEPlugin {
  readonly name: string;
  readonly version = '1.0.0';
  errors: unknown[] = [];

  constructor(
    name: string,
    private readonly models: CalculationModel<OutputValue>[] = [],
  ) {
    this.name = name;
  }

  onInit(context: PluginContext): void {
    for (const model of this.models) {
      context.modelRegistry.register(model);
    }
  }

  onError(error: unknown): void {
    this.errors.push(error);
  }
}

/**
 * A model that declares `output` and returns, for each rule, the value listed under its id
 * (throws for an unlisted rule). `calls` counts the computations.
 */
export class ValueModel implements CalculationModel<OutputValue> {
  readonly version = '1.0.0';
  calls = 0;

  constructor(
    readonly name: string,
    readonly output: OutputDeclaration | undefined,
    private readonly values: Readonly<Record<string, OutputValue | CalculationOutput<OutputValue>>>,
  ) {}

  validateParams(_params: unknown): ValidationResult {
    return { valid: true };
  }

  calculate(
    _input: Record<string, unknown>,
    matchedRule: Readonly<Rule>,
    _params: unknown,
  ): OutputValue | CalculationOutput<OutputValue> {
    this.calls += 1;
    const value = Object.hasOwn(this.values, matchedRule.id)
      ? this.values[matchedRule.id]
      : undefined;
    if (value === undefined) throw new Error(`${this.name} has no value for ${matchedRule.id}`);
    return value;
  }
}

/** Every ordering of `items`. */
export const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

/**
 * What a plugin's `onError` is told is a deep-frozen copy of the failure the caller receives, never
 * the same object: the same class, name, message, code, plugin and hook, and the same `cause` as
 * far as it can be read.
 */
export function expectSameFailure(told: unknown, received: unknown): void {
  expect(told).not.toBe(received);
  expect(Object.isFrozen(told)).toBe(true);
  const a = told as Record<string, unknown>;
  const b = received as Record<string, unknown>;
  expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b));
  for (const key of ['name', 'message', 'code', 'plugin', 'hook']) expect(a[key]).toEqual(b[key]);
  const ca = a['cause'] as { message?: unknown; name?: unknown } | undefined;
  const cb = b['cause'] as { message?: unknown; name?: unknown } | undefined;
  if (typeof cb === 'object' && cb !== null && typeof ca !== 'string') {
    expect(typeof ca).toBe('object');
    expect(ca?.message).toEqual(cb.message);
    expect(ca?.name).toEqual(cb.name);
  }
}
