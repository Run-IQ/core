import { ValidationError } from '../errors/ValidationError.js';

/**
 * Where the salt of the input digest comes from (Task 10 uses it): a `secret` of at least 32
 * bytes the seed is derived from per request, or a `derive(requestId)` that returns the 32 bytes
 * of the seed. In 9L it is only checked.
 */
export type InputSeedConfig =
  | { readonly secret: Uint8Array; readonly derive?: undefined }
  | { readonly derive: (requestId: string) => Uint8Array; readonly secret?: undefined };

const SEED_BYTES = 32;

const refuse = (...reasons: string[]): never => {
  throw new ValidationError('Invalid inputSeed', reasons);
};

/**
 * Checks the `inputSeed` of an engine's config at construction: an object with exactly one of
 * `secret` (a `Uint8Array` of at least 32 bytes) and `derive` (a function). `undefined` is no
 * seed. Throws `ValidationError` (`Invalid inputSeed`).
 */
export function readInputSeedConfig(value: unknown): InputSeedConfig | undefined {
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
    if (!(secret instanceof Uint8Array)) return refuse('inputSeed.secret must be a Uint8Array');
    if (secret.length < SEED_BYTES) return refuse('inputSeed.secret must be at least 32 bytes');
    // A copy: the caller may change the bytes, or detach the buffer, after this check.
    return { secret: new Uint8Array(secret) };
  }
  if (typeof derive !== 'function') return refuse('inputSeed.derive must be a function');
  // Called on the caller's object, so that a method keeps its `this`.
  const owner = value;
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
    derived = seed.derive(requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse(`inputSeed.derive failed: ${message}`);
  }
  if (!(derived instanceof Uint8Array) || derived.length !== SEED_BYTES) {
    refuse('inputSeed.derive must return 32 bytes');
  }
}
