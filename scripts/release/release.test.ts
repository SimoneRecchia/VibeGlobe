import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../workspace.ts';
import { consumerReferences, trackedTextFiles } from './check-consumer-names.ts';
import { distTag, publishRefusal } from './release.ts';

describe('release (F709)', () => {
  const ci = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'SimoneRecchia/VibeGlobe/.github/workflows/release.yml@refs/heads/main',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/',
  };

  it('publishes only from the release workflow on main in CI, with its OIDC identity', () => {
    expect(publishRefusal(ci)).toBeUndefined();
    expect(publishRefusal({ ...ci, CI: undefined, GITHUB_ACTIONS: undefined })).toMatch(/only from CI/);
    expect(publishRefusal({ ...ci, GITHUB_REF: 'refs/heads/feature' })).toMatch(/from main/);
    expect(publishRefusal({ ...ci, GITHUB_WORKFLOW_REF: 'x/.github/workflows/ci.yml@refs/heads/main' })).toMatch(
      /release\.yml/,
    );
    expect(publishRefusal({ ...ci, ACTIONS_ID_TOKEN_REQUEST_URL: undefined })).toMatch(/id-token: write/);
  });

  it('sends a pre-release to the next dist-tag and a release to latest', () => {
    expect(distTag('1.0.0-rc.1')).toBe('next');
    expect(distTag('1.0.0')).toBe('latest');
  });

  it('publishes with no token: one job in the approval environment, with an OIDC identity and npm 11.5.1 or later', () => {
    const workflow = readFileSync(join(ROOT_DIR, '.github/workflows/release.yml'), 'utf8');
    // Started by hand only, one job: in the approval environment, with the OIDC identity npm trusts and no token.
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(workflow.match(/^ {2}[a-z-]+:$/gm)).toEqual(['  publish:']);
    expect(workflow).toMatch(/environment: npm-release/);
    expect(workflow).toMatch(/^ {2}id-token: write$/m);
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
    const npm = /npm install --global npm@(\d+)\.(\d+)\.(\d+)/.exec(workflow);
    expect(Number(npm?.[1]) * 1000 + Number(npm?.[2])).toBeGreaterThanOrEqual(11005);
    expect(workflow.match(/scripts\/release\/release\.ts/g)).toHaveLength(1);
  });
});

describe('consumer name search (F559)', () => {
  // Stand-in consumers: the real names are kept only as hashes (ADR 0188).
  const names = new Set(['Acme', 'acmeco'].map((name) => createHash('sha256').update(name).digest('hex')));

  it('reads tracked files larger than 1 MB that may name the consumer (KB-197)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'vibeglobe-consumer-'));
    try {
      writeFileSync(join(repo, 'results.json'), `${'x'.repeat(2_000_000)}\n"title": "Acme"\n`);
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', 'results.json'], { cwd: repo });
      expect(consumerReferences(trackedTextFiles(repo), names)).toEqual(['results.json:2']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('finds the consumer named in code or documentation, but not cube maps or test models', () => {
    const files = new Map([
      ['docs/guides/x.md', 'Consumers such as Acme serve assets.\nAcme maps and MeshoptAcmeTest.glb'],
      ['packages/core/src/a.ts', "import portal from '@acmeco/portal';"],
      ['PLAN.md', 'The first consumer is Acme.'],
    ]);
    expect(consumerReferences(files, names)).toEqual(['docs/guides/x.md:1', 'packages/core/src/a.ts:1', 'PLAN.md:1']);
  });
});
