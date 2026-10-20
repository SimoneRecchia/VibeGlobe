// Compares the working-tree feature list with earlier committed versions (ADR 0003), using git.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFeatureList } from '../feature-list.ts';
import { findFeatureListViolations } from './feature-list-integrity.ts';

function git(rootDir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', rootDir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function fileAt(rootDir: string, revision: string): string | undefined {
  try {
    return git(rootDir, 'show', `${revision}:feature_list.json`);
  } catch {
    return undefined;
  }
}

/**
 * Checks `feature_list.json` in `rootDir` against its first committed version and against `baseRevision`. A base
 * revision older than the list is skipped (KB-003); one that does not exist is an error, never a silent pass.
 */
export function featureListViolationsSince(
  rootDir: string,
  baseRevision: string,
): { compared: string[]; violations: string[] } {
  try {
    git(rootDir, 'rev-parse', '--verify', '--quiet', `${baseRevision}^{commit}`);
  } catch {
    throw new Error(`Unknown base revision "${baseRevision}"`);
  }
  const added = git(rootDir, 'log', '--diff-filter=A', '--format=%H', '--', 'feature_list.json').split('\n');
  const current = parseFeatureList(readFileSync(join(rootDir, 'feature_list.json'), 'utf8'));
  const compared: string[] = [];
  const violations: string[] = [];
  for (const revision of new Set([added.at(-1), baseRevision])) {
    const base = revision ? fileAt(rootDir, revision) : undefined;
    if (!revision || base === undefined) continue;
    compared.push(revision);
    for (const violation of findFeatureListViolations(parseFeatureList(base), current)) {
      violations.push(`feature_list.json vs ${revision.slice(0, 12)}: ${violation}`);
    }
  }
  return { compared, violations };
}
