// F559: nothing in the engine refers to Cube, the first consumer (PLAN.md: "nothing in the engine refers to Cube").
// Searches every tracked file (code, packages, documentation) except PLAN.md, the feature list that quotes it, and
// integration examples that name Cube as a consumer, for the name and for a dependency on its code.
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../workspace.ts';

/** Files allowed to name Cube: the owner's brief, the feature list quoting it, the checks that look for it. */
const ALLOWED = [
  'PLAN.md',
  'feature_list.json',
  'docs/internal/feature-changes.md',
  // States PLAN.md's rule that nothing depends on Cube.
  'docs/internal/plan/architecture.md',
  'scripts/release/check-cube.ts',
  'scripts/release/release.test.ts',
  'scripts/checks/dependencies.ts',
  'scripts/checks/checks.test.ts',
];
/** The product name, a package scope or repository of its owner (not "cube map" or "MeshoptCubeTest"). */
const CUBE = /\b(?:Vireox|vireox|@vireox\/|Cube(?! ?maps?\b)(?=[\s.,;:)'"`]|$))/;

/** Lines that refer to Cube in the given files' contents, as `path:line: text`. */
export function cubeReferences(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [path, content] of files) {
    if (ALLOWED.includes(path)) continue;
    content.split('\n').forEach((line, index) => {
      if (CUBE.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

/**
 * The tracked files of the repository at `root` that may name Cube, with their indexed contents. Some are large (the
 * owner's benchmark results run to tens of MB, KB-197): git's output may be read up to 1 GB.
 */
export function candidateFiles(root: string = ROOT_DIR): Map<string, string> {
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 } as const;
  const listed = execFileSync('git', ['grep', '-I', '-l', '-E', 'Cube|[Vv]ireox'], options)
    .trim()
    .split('\n')
    .filter((path) => path !== '');
  return new Map(listed.map((path) => [path, execFileSync('git', ['show', `:${path}`], options)]));
}

if (import.meta.main) {
  const files = candidateFiles();
  const listed = [...files.keys()];
  const found = cubeReferences(files);
  for (const line of found) console.error(`FAIL  ${line}`);
  console.log(found.length === 0 ? `ok    no reference to Cube in ${listed.length} candidate files` : '');
  process.exit(found.length === 0 ? 0 : 1);
}
