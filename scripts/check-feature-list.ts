// Fails when feature_list.json breaks ADR 0003 relative to its first committed version and to a base revision
// (default HEAD; CI passes the commit before the push or the pull request base): `--base <rev>`.
import { execFileSync } from 'node:child_process';
import { findFeatureListViolations } from './checks/feature-list-integrity.ts';
import { loadFeatureList, parseFeatureList } from './feature-list.ts';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

const baseIndex = process.argv.indexOf('--base');
const baseRevision = baseIndex === -1 ? 'HEAD' : process.argv[baseIndex + 1];
const firstRevision = git('log', '--diff-filter=A', '--format=%H', '--', 'feature_list.json').split('\n').at(-1);
const revisions = [...new Set([firstRevision, baseRevision].filter((revision) => revision))] as string[];

const current = loadFeatureList();
let failed = false;
for (const revision of revisions) {
  const violations = findFeatureListViolations(parseFeatureList(git('show', `${revision}:feature_list.json`)), current);
  for (const violation of violations) console.error(`feature_list.json vs ${revision.slice(0, 12)}: ${violation}`);
  failed ||= violations.length > 0;
}
if (failed) process.exit(1);
console.log(
  `feature_list.json integrity OK (compared with ${revisions.map((r) => r.slice(0, 12)).join(', ') || 'nothing yet'})`,
);
