import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { validateProofInput } from '@run-iq/spec';
import type { ProofInput } from '@run-iq/spec';
import { NotPlain, isDateObject, isPlainPrototype } from '../../src/utils/plain.js';

// Core and spec have one definition of "plain". Spec's `isPlainObject` is not exported, so it is
// held to by behaviour: an object core calls plain is accepted by spec as `data`, and one core
// does not call plain is refused by spec (`neither plain nor an array`).

class Custom {
  a = 1;
}
const foreignEmpty = (): object => vm.runInNewContext('({ a: 1 })') as object;
const customProto = (): object => Object.create({ inherited: 1 }) as object;
const nullProto = (): object => Object.assign(Object.create(null) as object, { a: 1 });

const cases: [string, () => object, boolean][] = [
  ['an object literal', () => ({ a: 1 }), true],
  ['a null-prototype object', nullProto, true],
  ['an object of another realm', foreignEmpty, true],
  ['a class instance', () => new Custom(), false],
  ['an object with a custom prototype', customProto, false],
  ['a Map', () => new Map(), false],
  ['a Uint8Array', () => new Uint8Array(1), false],
  ['an Error', () => new Error('e'), false],
  ['a RegExp', () => /a/, false],
];

const refusedByDataSpec = (value: object): boolean =>
  validateProofInput({ data: { x: value }, meta: { tenantId: 't' } } as unknown as ProofInput).some(
    (issue) => issue.message.includes('neither plain nor an array'),
  );

describe('plain: core and spec agree', () => {
  it.each(cases)('%s', (_label, make, plain) => {
    const value = make();
    expect(isPlainPrototype(Object.getPrototypeOf(value))).toBe(plain);
    expect(refusedByDataSpec(value)).toBe(!plain);
  });

  it('an object whose prototype chain is not Object.prototype alone is not plain, even if it looks it', () => {
    const lookalike = Object.create(Object.create(null) as object) as object;
    expect(isPlainPrototype(Object.getPrototypeOf(lookalike))).toBe(false);
  });

  it('a Date is a Date of any realm, by its brand', () => {
    expect(isDateObject(new Date(0))).toBe(true);
    expect(isDateObject(vm.runInNewContext('new Date(0)') as object)).toBe(true);
    expect(isDateObject(Object.create(Date.prototype) as object)).toBe(false);
    expect(isDateObject(new Proxy(new Date(0), {}))).toBe(false);
  });

  it('the marker for what is not plain is a class spec refuses', () => {
    expect(isPlainPrototype(Object.getPrototypeOf(new NotPlain('x')))).toBe(false);
    expect(refusedByDataSpec(new NotPlain('x'))).toBe(true);
  });
});
