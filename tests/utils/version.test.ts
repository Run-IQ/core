import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { VERSION } from '../../src/index.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('VERSION', () => {
  it('is the package version', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
