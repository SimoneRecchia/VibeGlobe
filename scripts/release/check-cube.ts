// F559: nothing in the engine refers to Cube, the first consumer (PLAN.md: "nothing in the engine refers to Cube").
// Searches every tracked file (code, packages, documentation) except PLAN.md, the feature list that quotes it, and
// integration examples that name Cube as a consumer, for the name and for a dependency on its code.
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../workspace.ts';

/** Files allowed to name Cube: the owner's brief, the feature list quoting it, the checks that look for it. */
const ALLOWED = [
  'PLAN.md',
  'feature_list.json',
  'docs/feature-changes.md',
  // States PLAN.md's rule that nothing depends on Cube.
  'docs/plan/architecture.md',
  'scripts/release/check-cube.ts',
  'scripts/release/release.test.ts',
  'scripts/checks/dependencies.ts',
  'scripts/checks/checks.test.ts',
];
/** Integration examples that name Cube as a consumer of the engine. */
const INTEGRATION_EXAMPLES = /^docs\/guides\/integration\.md$/;
/** The product name, a package scope or repository of its owner (not "cube map" or "MeshoptCubeTest"). */
const CUBE = /\b(?:Vireox|vireox|@vireox\/|Cube(?! ?maps?\b)(?=[\s.,;:)'"`]|$))/;

/** Lines that refer to Cube in the given files' contents, as `path:line: text`. */
export function cubeReferences(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [path, content] of files) {
    if (ALLOWED.includes(path) || INTEGRATION_EXAMPLES.test(path)) continue;
    content.split('\n').forEach((line, index) => {
      if (CUBE.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

if (import.meta.main) {
  const listed = execFileSync('git', ['grep', '-I', '-l', '-E', 'Cube|[Vv]ireox'], { cwd: ROOT_DIR, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((path) => path !== '');
  const files = new Map(
    listed.map((path) => [path, execFileSync('git', ['show', `:${path}`], { cwd: ROOT_DIR, encoding: 'utf8' })]),
  );
  const found = cubeReferences(files);
  for (const line of found) console.error(`FAIL  ${line}`);
  console.log(found.length === 0 ? `ok    no reference to Cube in ${listed.length} candidate files` : '');
  process.exit(found.length === 0 ? 0 : 1);
}
