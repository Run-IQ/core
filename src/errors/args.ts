import { types } from 'node:util';
import { EngineConfigError } from './EngineConfigError.js';

/**
 * What the constructor of an exported error class takes. A bad argument is refused with a frozen
 * `EngineConfigError` naming the class and the position, never a raw `TypeError` from a template
 * string or a `join` (AJ4). Kinds: `s` a string, `n` a number, `S` a list of strings (a real
 * list, not a Proxy), a trailing `?` for an optional one, `*` for anything (read as text only).
 */
export type ArgKind = 's' | 'n' | 'S' | 's?' | 'n?' | '*';

export function checkArgs(cls: string, args: ReadonlyArray<readonly [unknown, ArgKind]>): void {
  args.forEach(([value, kind], position) => {
    if (kind === '*') return;
    if (kind.endsWith('?') && value === undefined) return;
    const base = kind.replace('?', '');
    const ok =
      base === 's'
        ? typeof value === 'string'
        : base === 'n'
          ? typeof value === 'number'
          : Array.isArray(value) &&
            !types.isProxy(value) &&
            (value as unknown[]).every((item) => typeof item === 'string');
    if (!ok) {
      const what = base === 's' ? 'a string' : base === 'n' ? 'a number' : 'a list of strings';
      throw new EngineConfigError(`/${cls}/argument${position}`, `must be ${what}`);
    }
  });
}
