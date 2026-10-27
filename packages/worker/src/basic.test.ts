import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASIC_TASKS } from './basic-tasks.js';
import { TASKS } from './tasks.js';

/** The modules a source file reaches through relative imports, itself included, as source paths. */
function moduleGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(new URL(entry, import.meta.url), 'utf8');
  for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g))
    moduleGraph(
      `./${new URL(specifier as string, new URL(entry, 'file:///src/')).pathname.slice(5).replace(/\.js$/, '.ts')}`,
      seen,
    );
  return seen;
}

describe('the basic worker program (ADR 0172, F532)', () => {
  it('reaches neither @vibeglobe/layers nor @vibeglobe/models from its entries', () => {
    for (const entry of ['./basic.ts', './vibeglobe-worker-basic.ts']) {
      const graph = moduleGraph(entry);
      expect(graph.has('./tasks.ts')).toBe(false);
      for (const file of graph)
        expect(readFileSync(new URL(file, import.meta.url), 'utf8'), file).not.toMatch(
          /(?:from\s*|import\s*\(\s*)['"]@vibeglobe\/(layers|models)/,
        );
    }
  });

  it('runs the imagery, terrain, KTX2 and vector tasks, and the full program runs them all', () => {
    expect(Object.keys(BASIC_TASKS)).toEqual(
      expect.arrayContaining(['decode-image', 'decode-terrain', 'transcode-ktx2', 'parse-geojson', 'decode-mvt']),
    );
    for (const [name, task] of Object.entries(BASIC_TASKS)) expect(TASKS[name]).toBe(task);
    expect(Object.keys(TASKS)).toEqual(expect.arrayContaining(['cluster-load', 'layout-vector-tile', 'parse-model']));
  });
});
