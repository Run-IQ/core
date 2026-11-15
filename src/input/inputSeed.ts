import { types } from 'node:util';
import { ValidationError } from '../errors/ValidationError.js';
import { CallbackError } from '../errors/CallbackError.js';
import { callSync } from '../engine/pluginPort.js';

/**
 * Where the salt of the input digest comes from (Task 10 uses it): a `secret` of at least 32
 * bytes the seed is derived from per request, or a `derive(requestId)` that returns the 32 bytes
 * of the seed. In 9L it is only checked.
 */
export type InputSeedConfig =
  | { readonly secret: Uint8Array; readonly derive?: undefined }
  | { readonly derive: (requestId: string) => Uint8Array; readonly secret?: undefined };

const SEED_BYTES = 32;

// The `byteLength` getter of every typed array, captured when the module loads.
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)?.get as (this: Uint8Array) => number;
const byteLengthOf = (bytes: Uint8Array): number =>
  Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, bytes, []) as number;

const refuse = (...reasons: string[]): never => {
  throw new ValidationError('Invalid inputSeed', reasons);
};

/**
 * Checks the `inputSeed` of an engine's config at construction: an object with exactly one of
 * `secret` (a `Uint8Array` of at least 32 bytes) and `derive` (a function). `undefined` is no
 * seed. Throws `ValidationError` (`Invalid inputSeed`).
 */
export function readInputSeedConfig(
  value: unknown,
  /** What `derive` is called on: the caller's own object, so that a method keeps its `this`. */
  owner: unknown = value,
): InputSeedConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refuse('inputSeed must be an object');
  }
  const { secret, derive } = value as { secret?: unknown; derive?: unknown };
  if (secret !== undefined && derive !== undefined) {
    return refuse('inputSeed must have secret or derive, not both');
  }
  if (secret === undefined && derive === undefined) {
    return refuse('inputSeed must have secret or derive');
  }
  if (secret !== undefined) {
    // Told by the engine's intrinsics, never by `instanceof` or the object's own `length`: a
    // subclass or a Proxy that lies about its size cannot change what is checked and kept.
    if (!types.isUint8Array(secret)) return refuse('inputSeed.secret must be a Uint8Array');
    // A copy: the caller may change the bytes, or detach the buffer, after this check. The size
    // checked is the size of the copy.
    const copy = new Uint8Array(secret);
    if (byteLengthOf(copy) < SEED_BYTES)
      return refuse('inputSeed.secret must be at least 32 bytes');
    return { secret: copy };
  }
  if (typeof derive !== 'function') return refuse('inputSeed.derive must be a function');
  return { derive: (requestId) => Reflect.apply(derive, owner, [requestId]) as Uint8Array };
}

/**
 * Calls `derive(requestId)` of a seed config and checks its answer: exactly 32 bytes. Throws
 * `ValidationError` (`Invalid inputSeed`) otherwise, naming a `derive` that throws. A `secret`
 * has nothing to check per request.
 */
export function checkDerivedSeed(seed: InputSeedConfig | undefined, requestId: string): void {
  if (seed?.derive === undefined) return;
  let derived: unknown;
  try {
    // Synchronous, like the plugin hooks: a thenable is a breach, never awaited, its rejection
    // handled. A failure is held as bounded text, never converted (AI2, AI3).
    derived = callSync(seed.derive as (...args: never[]) => unknown, undefined, [requestId]);
  } catch (error) {
    throw new CallbackError('inputSeed.derive', error);
  }
  // By the intrinsics: no `length` of the answer, and no trap of it, is ever run.
  if (!types.isUint8Array(derived) || byteLengthOf(derived) !== SEED_BYTES) {
    refuse('inputSeed.derive must return 32 bytes');
  }
}
