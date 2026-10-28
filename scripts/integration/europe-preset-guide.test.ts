// F616: the Europe preset guide (docs/guides/europe-preset.md) has a section for each use, the maximum online zoom per
// area and an example output of `estimate`, and every `ts` example type-checks against the packages' sources.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const GUIDE = readFileSync('docs/guides/europe-preset.md', 'utf8');
const EXAMPLES = [...GUIDE.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
/** The values the examples take from the application. */
const PREAMBLE = [
  'declare const container: HTMLElement;',
  "declare const renderer: import('@vibeglobe/core').RendererFactory;",
  'declare const customerKey: string;',
  '',
].join('\n');

/** Type errors of the examples, compiled as modules of an application against the workspace's sources. */
function typeErrors(examples: readonly string[]): string[] {
  const dir = resolve('scripts/integration/.europe-guide');
  const files = new Map(examples.map((code, i) => [join(dir, `example-${String(i + 1)}.ts`), PREAMBLE + code]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ['source'],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, version, ...rest) => {
    const text = files.get(name);
    return text === undefined ? getSourceFile(name, version, ...rest) : ts.createSourceFile(name, text, version);
  };
  host.fileExists = (name) => files.has(name) || fileExists(name);
  host.readFile = (name) => files.get(name) ?? readFile(name);
  const program = ts.createProgram([...files.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && files.has(d.file.fileName))
    .map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

it(
  'the Europe preset guide covers each use, the online zoom per area and estimate, and its examples type-check (F616)',
  {
    timeout: 120_000,
  },
  () => {
    for (const heading of [
      '## Map types and sources',
      '## Hybrid: the package plus online detail',
      '## Online only',
      '## Offline only',
      '## Your own sources',
      '## National and regional orthophotos',
      '## Maximum online zoom per area',
      '## Building the package',
      '## Estimating the package',
      '## Hosting the package',
    ])
      expect(GUIDE).toContain(heading);
    // The estimate's table: land and sea counts and cumulative gigabytes for imagery, terrain and vector tiles.
    for (const dataset of ['europe-satellite', 'europe-terrain', 'europe-vectors'])
      expect(GUIDE).toContain(`  ${dataset} [region]`);
    expect(GUIDE).toMatch(/zoom\s+land tiles\s+sea tiles\s+tiles\s+size\s+cumulative\s+sizes/);
    expect(EXAMPLES.length).toBe(6);
    expect(typeErrors(EXAMPLES)).toEqual([]);
  },
);
