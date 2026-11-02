import { EngineLimitError } from '../errors/EngineLimitError.js';
import type { EngineLimits } from '../limits.js';
import { describeThrown } from '../utils/values.js';

/** The segment of a JSON pointer for `key`: `~` is `~0`, `/` is `~1`. */
const escapeSegment = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** One container being copied. */
interface Frame {
  readonly src: object;
  readonly dst: Record<string, unknown> | unknown[];
  /** The keys of an object; `undefined` for a list, read by index up to `length`. */
  readonly keys: readonly string[] | undefined;
  readonly length: number;
  index: number;
  readonly depth: number;
  readonly parent: Frame | undefined;
  /** The key (or index) of this container in its parent. */
  readonly key: string | number | undefined;
}

/**
 * Makes the one plain copy of an input that the engine checks and evaluates (D-5, D-26), while
 * holding it to the bounds of the input. Without recursion, so no nesting overflows the stack.
 *
 * - Each property is read once, by `Object.keys` and then by key (a list by index up to a length
 *   read once): the copy holds the values the checks see, whatever a getter or a Proxy would
 *   answer to a second read. A property that cannot be read is named in `reasons`
 *   (`<pointer> could not be read: <reason>`, spec's words) and left out of the copy.
 * - Plain objects and lists are copied; anything else (a `Date`, a `Map`, a function, a symbol)
 *   is kept as it is, for `validateProofInput` to refuse it. A hole of a list stays a hole.
 * - `-0` is written `0`, so that the value evaluated is the value hashed (D-5).
 * - An own `__proto__` key stays an own key; the prototype of the copy is never changed.
 * - `leaves` counts, over every part copied by this instance (`data`, then each member of
 *   `meta`), the leaves of the input tree (D-15): each scalar, each list and each empty object,
 *   on every path. A container is a level of depth if it has members; each part starts at level
 *   1. Past `maxInputLeaves` or `maxInputDepth` it throws `EngineLimitError` with `actual` the
 *   first value past the bound. Its cost is bounded by the bound and by the width of one
 *   object: `Object.keys` lists the keys of an object before the first of them is counted.
 */
export class InputCopier {
  /** The leaves counted so far, over every part copied. */
  leaves = 0;
  /** The properties that could not be read, in the order met. */
  readonly reasons: string[] = [];

  constructor(private readonly limits: Readonly<EngineLimits>) {}

  private leaf(): void {
    this.leaves += 1;
    if (this.leaves > this.limits.maxInputLeaves) {
      throw new EngineLimitError('maxInputLeaves', this.limits.maxInputLeaves, this.leaves);
    }
  }

  /** `rootPointer` followed by the keys of `frame` and `key`: where a failure is named. */
  private pointer(rootPointer: string, frame: Frame | undefined, key: string | number): string {
    const segments: string[] = [escapeSegment(String(key))];
    for (let f = frame; f !== undefined; f = f.parent) {
      if (f.key !== undefined) segments.unshift(escapeSegment(String(f.key)));
    }
    return `${rootPointer}/${segments.join('/')}`;
  }

  private unreadable(pointer: string, error: unknown): void {
    this.reasons.push(`${pointer} could not be read: ${describeThrown(error)}`);
    this.leaf();
  }

  /** The copy of `root`, a part of the input at `rootPointer` (`/data`, `/meta/context`). */
  copy(root: unknown, rootPointer: string): unknown {
    const top: { value: unknown } = { value: undefined };
    const stack: Frame[] = [];

    const put = (
      parent: Frame | undefined,
      key: string | number | undefined,
      value: unknown,
    ): void => {
      if (parent === undefined || key === undefined) top.value = value;
      else if (Array.isArray(parent.dst)) parent.dst[key as number] = value;
      else if (key === '__proto__') {
        Object.defineProperty(parent.dst, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else parent.dst[key as string] = value;
    };

    const place = (
      value: unknown,
      depth: number,
      parent: Frame | undefined,
      key: string | number | undefined,
    ): void => {
      if (value === null || typeof value !== 'object') {
        this.leaf();
        put(parent, key, typeof value === 'number' && Object.is(value, -0) ? 0 : value);
        return;
      }
      const at = (): string =>
        key === undefined ? rootPointer : this.pointer(rootPointer, parent, key);
      let isList: boolean;
      let keys: string[] | undefined;
      let length: number;
      try {
        isList = Array.isArray(value);
        if (isList) {
          length = (value as unknown[]).length;
          if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('invalid length');
        } else {
          const prototype: unknown = Object.getPrototypeOf(value);
          if (prototype !== Object.prototype && prototype !== null) {
            this.leaf();
            put(parent, key, value);
            return;
          }
          keys = Object.keys(value);
          length = keys.length;
        }
      } catch (error) {
        this.unreadable(at(), error);
        return;
      }
      // A list is a leaf (its elements have their own), and so is an empty object.
      if (isList || length === 0) this.leaf();
      const dst: Record<string, unknown> | unknown[] = isList ? [] : {};
      put(parent, key, dst);
      if (length === 0) return;
      if (depth > this.limits.maxInputDepth) {
        throw new EngineLimitError('maxInputDepth', this.limits.maxInputDepth, depth);
      }
      stack.push({ src: value, dst, keys, length, index: 0, depth, parent, key });
    };

    place(root, 1, undefined, undefined);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      if (frame.index >= frame.length) {
        stack.pop();
        if (Array.isArray(frame.dst)) frame.dst.length = frame.length; // trailing holes
        continue;
      }
      const i = frame.index++;
      const memberKey = frame.keys === undefined ? i : (frame.keys[i] as string);
      let member: unknown;
      try {
        if (frame.keys === undefined && !Object.hasOwn(frame.src, i)) continue; // a hole
        member =
          frame.keys === undefined
            ? (frame.src as unknown[])[i]
            : (frame.src as Record<string, unknown>)[memberKey as string];
      } catch (error) {
        this.unreadable(this.pointer(rootPointer, frame, memberKey), error);
        continue;
      }
      place(member, frame.depth + 1, frame, memberKey);
    }
    return top.value;
  }
}
