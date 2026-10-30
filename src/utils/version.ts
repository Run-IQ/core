// A named import: the bundler inlines only this field, not the whole package.json.
import { version } from '../../package.json';

/** This package's version, read from package.json at build time. */
export const VERSION: string = version;
