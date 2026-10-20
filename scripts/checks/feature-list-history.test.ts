import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { featureListViolationsSince } from './feature-list-history.ts';

const list = (description: string): string =>
  `${JSON.stringify(
    {
      milestones: { '1': 'One' },
      features: [{ id: 'F001', milestone: 1, section: 'S', description, steps: ['a', 'b'], status: 'failing' }],
    },
    null,
    2,
  )}\n`;

describe('featureListViolationsSince (KB-003)', () => {
  let dir = '';
  let beforeList = '';
  let withList = '';
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vge-feature-list-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'PLAN.md'), '# Plan\n');
    git('add', '.');
    git('commit', '-q', '-m', 'plan only');
    beforeList = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'feature_list.json'), list('Original behavior'));
    git('add', '.');
    git('commit', '-q', '-m', 'add the feature list');
    withList = git('rev-parse', 'HEAD');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts a base revision that predates the feature list, comparing with the first version only', () => {
    expect(featureListViolationsSince(dir, beforeList)).toEqual({ compared: [withList], violations: [] });
  });

  it('still reports rewording against the first version when the base predates the list', () => {
    writeFileSync(join(dir, 'feature_list.json'), list('Easier behavior'));
    expect(featureListViolationsSince(dir, beforeList).violations).toEqual([
      `feature_list.json vs ${withList.slice(0, 12)}: F001: description changed`,
    ]);
  });

  it('rejects a base revision that does not exist instead of passing vacuously', () => {
    expect(() => featureListViolationsSince(dir, '0123456789abcdef0123456789abcdef01234567')).toThrow(
      /Unknown base revision/,
    );
  });
});
