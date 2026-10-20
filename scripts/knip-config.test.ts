import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('knip configuration (KB-004)', () => {
  it('reports unused exports of the root entry files, so script modules cannot hide dead code', () => {
    const config = JSON.parse(readFileSync(new URL('../knip.json', import.meta.url), 'utf8')) as {
      workspaces: Record<string, { includeEntryExports?: boolean }>;
    };
    expect(config.workspaces['.']?.includeEntryExports).toBe(true);
  });
});
