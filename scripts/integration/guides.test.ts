// The guides are read mostly by AI agents writing applications: every `ts` example of every guide type-checks against
// the packages' sources, every link of the documentation an application reads leads to a file wherever it is read, and
// llms.txt lists every guide.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const GUIDES_DIR = 'docs/guides';
const GUIDES = readdirSync(GUIDES_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => join(GUIDES_DIR, name));
const PACKAGE_READMES = readdirSync('packages')
  .map((name) => join('packages', name, 'README.md'))
  .filter((path) => existsSync(path));
/** What an application reads: the README, the index for agents, the guides, the data licenses, the packages' READMEs. */
const PUBLIC_DOCS = ['README.md', 'llms.txt', 'docs/data-licenses.md', ...GUIDES, ...PACKAGE_READMES].filter((path) =>
  existsSync(path),
);
/** The values the examples take from the application. */
const PREAMBLE = [
  'declare const container: HTMLElement;',
  "declare const renderer: import('@vibeglobe/core').RendererFactory;",
  'declare const customerKey: string;',
  '',
].join('\n');

const examplesOf = (text: string): string[] => [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');

/** Type errors of the examples, each compiled as a module of an application against the workspace's sources. */
function typeErrors(examples: ReadonlyMap<string, string>): string[] {
  const dir = resolve('scripts/integration/.guides');
  // A module each, so the examples' names never collide.
  const files = new Map(
    [...examples].map(([name, code]) => [join(dir, `${name}.ts`), `${PREAMBLE}${code}\nexport {};\n`]),
  );
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
    .map((d) => {
      const { line } = d.file?.getLineAndCharacterOfPosition(d.start ?? 0) ?? { line: 0 };
      const name = (d.file?.fileName ?? '').slice(dir.length + 1);
      return `${name}:${String(line + 1 - PREAMBLE.split('\n').length + 1)}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
}

it('every ts example of the guides and the READMEs type-checks against the packages', { timeout: 180_000 }, () => {
  const examples = new Map(
    ['README.md', ...GUIDES, ...PACKAGE_READMES].flatMap((path) =>
      examplesOf(readFileSync(path, 'utf8')).map(
        (code, i) => [`${path.replace(/\.md$/, '').replaceAll('/', '_')}-${String(i + 1)}`, code] as const,
      ),
    ),
  );
  expect(examples.size).toBeGreaterThan(0);
  expect(typeErrors(examples)).toEqual([]);
});

const REPOSITORY = 'https://github.com/SimoneRecchia/VibeGlobe/blob/main/';
/** What travels in `@vibeglobe/core` (scripts/release/core-docs.ts): its documents link only among themselves. */
const SHIPPED_WITH_CORE = ['llms.txt', 'docs/data-licenses.md', ...GUIDES];

const linksOf = (path: string): string[] =>
  [...readFileSync(path, 'utf8').matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)].map((m) => m[1] ?? '');

/** Whether a relative link from `path` to `file` still works where the document is read: in its package or on GitHub. */
function travels(path: string, file: string): boolean {
  if (SHIPPED_WITH_CORE.includes(path)) return SHIPPED_WITH_CORE.includes(file);
  return path === 'README.md' || file.startsWith(`${dirname(path)}/`);
}

it('every link of the public documentation leads to a file, wherever the document is read', () => {
  const problems = PUBLIC_DOCS.flatMap((path) =>
    linksOf(path).flatMap((target) => {
      if (target.startsWith(REPOSITORY))
        return existsSync(target.slice(REPOSITORY.length)) ? [] : [`${path}: ${target}`];
      if (/^(?:[a-z]+:|\/)/.test(target)) return [];
      const file = join(dirname(path), decodeURI(target));
      if (!existsSync(file)) return [`${path}: ${target} does not exist`];
      return travels(path, file) ? [] : [`${path}: ${target} is not shipped with it, link ${REPOSITORY}${file}`];
    }),
  );
  expect(problems).toEqual([]);
});

it('llms.txt lists every guide', () => {
  const listed = new Set(linksOf('llms.txt'));
  expect(GUIDES.filter((path) => !listed.has(path))).toEqual([]);
});
