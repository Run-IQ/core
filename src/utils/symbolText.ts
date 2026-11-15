// The description getter of every symbol, captured when the module loads (before any plugin): a
// symbol is described through it, never through `Symbol.prototype.toString`, which a plugin can patch.
const DESCRIPTION = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description')?.get as (
  this: symbol,
) => string | undefined;

/** `Symbol(description)`, with no lookup of a method a plugin could have replaced. */
export function symbolText(value: symbol): string {
  return `Symbol(${Reflect.apply(DESCRIPTION, value, []) ?? ''})`;
}
