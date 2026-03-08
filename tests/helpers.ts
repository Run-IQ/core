import { hashParams } from '../src/utils/crypto.js';
import type { Rule } from '../src/types/rule.js';
import type { EvaluationInput } from '../src/types/input.js';
import type { CalculationModel, ValidationResult } from '../src/types/model.js';
import type { DSLEvaluator } from '../src/types/dsl.js';
import type { ISnapshotAdapter, Snapshot } from '../src/types/snapshot.js';
import type { PPEPlugin, PluginContext } from '../src/types/plugin.js';

export function makeChecksum(params: unknown): string {
  return hashParams(params);
}

export function makeRule(overrides: Partial<Rule> & { id: string; model: string }): Rule {
  const params = overrides.params ?? {};
  return {
    version: 1,
    priority: 100,
    effectiveFrom: new Date('2024-01-01'),
    effectiveUntil: null,
    tags: [],
    checksum: makeChecksum(params),
    params,
    ...overrides,
  };
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
    private readonly models: CalculationModel[] = [],
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
