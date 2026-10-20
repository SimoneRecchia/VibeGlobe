// Fails when tests were removed or quality gates loosened relative to a base revision (default HEAD; CI passes the
// commit before the push or the pull request base): `--base <rev>`. Justified changes are listed in
// docs/test-changes.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findLoosenedGates, findRemovedTests } from './checks/test-guard.ts';
import { ROOT_DIR } from './workspace.ts';

const GATES = [
  { file: 'quality/coverage.json', direction: 'minimum' },
  { file: 'quality/budgets.json', direction: 'maximum' },
  { file: 'quality/visual-tolerances.json', direction: 'maximum' },
] as const;
const TEST_FILE = /\.(test|spec)\.ts$/;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function readAtBase(revision: string, path: string): string | undefined {
  try {
    return git('show', `${revision}:${path}`);
  } catch {
    return undefined;
  }
}

const baseIndex = process.argv.indexOf('--base');
const base = baseIndex === -1 ? 'HEAD' : (process.argv[baseIndex + 1] as string);
const log = readFileSync(join(ROOT_DIR, 'docs/test-changes.md'), 'utf8');

const baseTests = new Map(
  git('ls-tree', '-r', '--name-only', base)
    .split('\n')
    .filter((path) => TEST_FILE.test(path))
    .map((path) => [path, readAtBase(base, path) ?? ''] as const),
);
const currentTests = new Map(
  git('ls-files', '--cached', '--others', '--exclude-standard')
    .split('\n')
    .filter((path) => TEST_FILE.test(path) && existsSync(join(ROOT_DIR, path)))
    .map((path) => [path, readFileSync(join(ROOT_DIR, path), 'utf8')] as const),
);

const violations = findRemovedTests(baseTests, currentTests, log);
for (const gate of GATES) {
  const before = readAtBase(base, gate.file);
  if (before === undefined) continue;
  const now = existsSync(join(ROOT_DIR, gate.file)) ? readFileSync(join(ROOT_DIR, gate.file), 'utf8') : '{}';
  violations.push(...findLoosenedGates(gate.file, gate.direction, JSON.parse(before), JSON.parse(now), log));
}

for (const violation of violations) console.error(violation);
if (violations.length > 0) {
  console.error('Record a justified change in docs/test-changes.md, or restore the test or gate.');
  process.exit(1);
}
console.log(`Test guard OK against ${base} (${currentTests.size} test files).`);
