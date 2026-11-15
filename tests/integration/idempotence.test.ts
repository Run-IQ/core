import { describe, it, expect } from 'vitest';
import { PPEEngine } from '../../src/engine/PPEEngine.js';
import { DuplicateRequestError } from '../../src/errors/DuplicateRequestError.js';
import { makeRule, makeInput, StubModel, StubPlugin, InMemorySnapshotAdapter } from '../helpers.js';

describe('Idempotence', () => {
  it('refuses a duplicate requestId with DUPLICATE_REQUEST', async () => {
    const adapter = new InMemorySnapshotAdapter();
    const model = new StubModel('m', 500);
    const plugin = new StubPlugin('test', [model]);

    const engine = new PPEEngine({
      plugins: [plugin],
      dsls: [],
      snapshot: adapter,
      strict: false,
    });

    const rules = [makeRule({ id: 'r1', model: 'm', params: {} })];
    const input = makeInput({ requestId: 'idempotent-001' });

    // First call
    const result1 = await engine.evaluate(rules, input);
    expect(result1.value).toBe(500);

    // Second call with same requestId
    // A requestId already seen is refused by name, never answered with a stub (Task 10 returns
    // the stored decision with fromStore: true).
    const error = await engine.evaluate(rules, input).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DuplicateRequestError);
    expect(error).toMatchObject({
      name: 'DuplicateRequestError',
      code: 'DUPLICATE_REQUEST',
      message:
        'request idempotent-001 was already evaluated; its stored decision is returned from Task 10',
    });
  });
});
