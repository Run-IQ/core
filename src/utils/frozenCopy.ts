/**
 * A deep, frozen copy of an error for a plugin that is told of it: its own properties, its `cause`
 * chain and any list in it, copied, so that nothing a plugin writes reaches the error the caller
 * receives. Bounded in depth, and safe on cycles.
 */
export function frozenErrorCopy(
  value: unknown,
  depth = 0,
  seen = new Map<object, unknown>(),
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (depth > 16) return '[too deep]';
  try {
    const copy: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      Object.defineProperty(copy, key, {
        value: frozenErrorCopy(descriptor.value, depth + 1, seen),
        enumerable: descriptor.enumerable === true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(copy);
  } catch {
    return '[unreadable]';
  }
}
