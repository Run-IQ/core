import { EngineLimitError } from '../errors/EngineLimitError.js';
import type { EngineLimits } from '../limits.js';
import { describeThrown } from '../utils/values.js';
import { NotPlain, isDateObject, isPlainPrototype } from '../utils/plain.js';
import { toReferenceDate } from '@run-iq/spec';

/** Characters that weigh one node. */
const CHARS_PER_NODE = 64;

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
 * - Plain objects and lists are copied, and every copied container is frozen: nothing that holds
 *   the copy (a hook, a DSL, a model) can write into it. A `Date` is copied (frozen it would still
 *   be writable). Anything else (a `Map`, a function, a symbol) is kept as it is, for
 *   `validateProofInput` to refuse it.
 * - A list stops at its first hole (`<pointer> has a hole at index i: arrays must be dense`), so a
 *   sparse list of any length costs one step. A symbol key or a non-enumerable property of an
 *   object is named too (`<pointer> has a symbol key: Symbol(s)`, `<pointer>/k is not
 *   enumerable`): it would vanish from the copy.
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
  /** What was thrown by the properties that could not be read, in the same order. */
  readonly thrown: unknown[] = [];
  /** In rule mode, the objects that are not plain: `<pointer> is not a plain object: Kind`. */
  readonly refusals: string[] = [];

  /**
   * @param limits - the bounds.
   * @param leafLimit - which limit holds the leaves: `maxInputLeaves` for the input,
   * `maxRuleLeaves` for a rule.
   */
  constructor(
    private readonly limits: Readonly<EngineLimits>,
    private readonly leafLimit: 'maxInputLeaves' | 'maxRuleLeaves' = 'maxInputLeaves',
    /**
     * Write every `Date` as its canonical string (`YYYY-MM-DDTHH:MM:SS.sssZ`), as for a rule: the
     * engine then holds no `Date` object that anybody could move.
     */
    private readonly datesAsStrings = false,
    /**
     * A rule is read: an object that is not plain is not placed as a marker but written as the
     * string `<not plain: Kind>`, and named in `refusals` with its pointer, so that the rule is
     * excluded for it and nothing but plain data reaches the record.
     */
    private readonly ruleMode = false,
  ) {}

  private leaf(extra = 0): void {
    this.leaves += 1 + extra;
    if (this.leaves > this.limits[this.leafLimit]) {
      throw new EngineLimitError(this.leafLimit, this.limits[this.leafLimit], this.leaves);
    }
  }

  /**
   * Holds a string (a value or a key) to `maxStringLength` and returns the nodes its characters
   * add: one per `CHARS_PER_NODE`, so that a long text costs what it weighs.
   */
  private text(value: string, pointer: () => string): number {
    if (value.length > this.limits.maxStringLength) {
      throw new EngineLimitError(
        'maxStringLength',
        this.limits.maxStringLength,
        value.length,
        pointer(),
      );
    }
    return Math.floor(value.length / CHARS_PER_NODE);
  }

  /** `rootPointer` followed by the keys of `frame` and `key`: where a failure is named. */
  private pointer(rootPointer: string, frame: Frame | undefined, key: string | number): string {
    const segments: string[] = [escapeSegment(String(key))];
    for (let f = frame; f !== undefined; f = f.parent) {
      if (f.key !== undefined) segments.unshift(escapeSegment(String(f.key)));
    }
    return `${rootPointer}/${segments.join('/')}`;
  }

  /** Counts one node: a key of an object the caller walks itself (the members of `meta`). */
  node(): void {
    this.leaf();
  }

  /** Names a property that cannot be read, and counts it as a leaf. */
  unreadable(pointer: string, error: unknown): void {
    this.reasons.push(`${pointer} could not be read: ${describeThrown(error)}`);
    this.thrown.push(error);
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
        const extra =
          typeof value === 'string'
            ? this.text(value, () =>
                key === undefined ? rootPointer : this.pointer(rootPointer, parent, key),
              )
            : 0;
        this.leaf(extra);
        if (value === undefined && this.ruleMode && parent !== undefined && key !== undefined) {
          // `undefined` is not a JSON value: a member that holds it makes the rule refused.
          this.refusals.push(`${this.pointer(rootPointer, parent, key)} is not JSON: undefined`);
          put(parent, key, '<undefined>');
          return;
        }
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
          // justification: `Array.isArray` passed.
          length = (value as unknown[]).length;
          if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('invalid length');
        } else {
          // Plainness is decided once, from one read of the prototype.
          const prototype: unknown = Object.getPrototypeOf(value);
          if (!isPlainPrototype(prototype)) {
            // A Date is copied (or written as its string, for a rule), so that nobody holds the
            // one the evaluation records. Spec refuses it in `data` and `meta.context`;
            // `meta.effectiveDate` and `meta.dates` take it. Anything else that is not plain is
            // replaced by a marker spec refuses, never kept. The brand is read only here: a plain
            // object is not a date, and a read through a Proxy is not wasted on every object.
            this.leaf();
            if (isDateObject(value)) {
              // justification: `isDateObject` passed, so `getTime` returns a number.
              const time = Date.prototype.getTime.call(value) as number;
              let copy: unknown = new Date(time);
              if (this.datesAsStrings) {
                try {
                  copy = toReferenceDate(new Date(time));
                } catch {
                  if (this.ruleMode) {
                    this.refusals.push(`${at()} is an invalid Date`);
                    copy = '<invalid Date>';
                  } else copy = new NotPlain('an invalid Date');
                }
              }
              put(parent, key, copy);
            } else if (this.ruleMode) {
              const kind = describeKind(prototype);
              this.refusals.push(`${at()} is not a plain object: ${kind}`);
              put(parent, key, `<not plain: ${kind}>`);
            } else {
              put(parent, key, new NotPlain(describeKind(prototype)));
            }
            return;
          }
          // One listing of the own keys; enumerability is read per key. A symbol key
          // or a non-enumerable property would vanish from the copy: it is named instead.
          keys = [];
          for (const own of Reflect.ownKeys(value)) {
            if (typeof own === 'symbol') {
              this.reasons.push(`${at()} has a symbol key: ${own.toString()}`);
            } else if (!Object.prototype.propertyIsEnumerable.call(value, own)) {
              this.reasons.push(`${at()}/${escapeSegment(own)} is not enumerable`);
            } else keys.push(own);
          }
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
      if (length === 0) {
        Object.freeze(dst);
        return;
      }
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
        // Frozen as soon as it is complete: nothing that holds the copy can write into it.
        Object.freeze(frame.dst);
        continue;
      }
      const i = frame.index++;
      const memberKey = frame.keys === undefined ? i : (frame.keys[i] as string);
      let member: unknown;
      try {
        if (frame.keys === undefined && !Object.hasOwn(frame.src, i)) {
          // The first hole ends the list: a sparse list of any length costs one step, and spec
          // refuses it in these very words.
          this.reasons.push(
            `${frame.key === undefined ? rootPointer : this.pointer(rootPointer, frame.parent, frame.key)} has a hole at index ${i}: arrays must be dense`,
          );
          frame.index = frame.length;
          continue;
        }
        member =
          frame.keys === undefined
            ? (frame.src as unknown[])[i]
            : (frame.src as Record<string, unknown>)[memberKey as string];
      } catch (error) {
        this.unreadable(this.pointer(rootPointer, frame, memberKey), error);
        continue;
      }
      // An object key is a node of its own, as a scalar and a list element are: a wide object
      // costs what it holds, not only its values.
      // Its characters weigh too.
      if (frame.keys !== undefined) {
        this.leaf(
          this.text(memberKey as string, () => this.pointer(rootPointer, frame, memberKey)),
        );
      }
      place(member, frame.depth + 1, frame, memberKey);
    }
    return top.value;
  }
}

/**
 * The enumerable string keys of `value`, listed once, plus a reason for each own key that would
 * vanish from a copy: a symbol key (`<pointer> has a symbol key: Symbol(s)`) and a non-enumerable
 * property (`<pointer>/k is not enumerable`). For the root of the input and for `meta`, which the
 * copier does not walk as containers.
 */
export function listKeys(value: object, pointer: string, reasons: string[]): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      reasons.push(`${pointer === '' ? 'input' : pointer} has a symbol key: ${key.toString()}`);
    } else if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      reasons.push(`${pointer}/${escapeSegment(key)} is not enumerable`);
    } else {
      keys.push(key);
    }
  }
  return keys;
}

/** What kind of object a prototype describes, for the marker that stands in for it. */
function describeKind(prototype: unknown): string {
  try {
    const ctor: unknown = (prototype as { constructor?: unknown } | null)?.constructor;
    return typeof ctor === 'function' && ctor.name !== '' ? ctor.name : 'an object';
  } catch {
    return 'an object';
  }
}
