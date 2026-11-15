/**
 * The exact length of `value` as `JSON.stringify` writes it: the two quotes, and every character
 * that JSON escapes at the length it is written (`"` and `\` 2, `\b \t \n \f \r` 2, any other
 * control character and any lone surrogate 6). This is the weight of a string or a key: the text
 * the checksum and the record hold, counted as they hold it, not estimated.
 */
export function serializedLength(value: string): number {
  const length = value.length;
  // Most text has nothing to escape: one scan, no allocation.
  if (!NEEDS_ESCAPE.test(value)) return length + 2;
  let extra = 0;
  for (let index = 0; index < length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) extra += 1;
    else if (code < 0x20)
      extra += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdfff) {
      if (code <= 0xdbff && index + 1 < length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          index += 1; // a pair is written as it is
          continue;
        }
      }
      extra += 5; // a lone surrogate is written \udXXX
    }
  }
  return length + 2 + extra;
}

// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/** Serialized characters that weigh one node. */
export const CHARS_PER_NODE = 64;

/**
 * `text` cut to at most `max` characters, never in the middle of a surrogate pair, with `marker`
 * when it was cut, and well-formed (a lone surrogate becomes U+FFFD): text the record can hold.
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g');

/** True when `text` holds a lone surrogate, which the canonical form of spec refuses. */
export function hasLoneSurrogate(text: string): boolean {
  const native = (text as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof native === 'function') return !native.call(text);
  return LONE_SURROGATE.test(text);
}

export function clipText(text: string, max: number, marker: string): string {
  const whole = LONE_SURROGATE.test(text) ? text.replace(LONE_SURROGATES, '\uFFFD') : text;
  if (whole.length <= max) return whole;
  let end = max;
  const last = whole.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // the cut would split a pair
  return `${whole.slice(0, end)}${marker}`;
}
