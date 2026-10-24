import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../workspace.ts';
import { CHANGELOG_HEADER, addEntry, changelogEntry, type Commit } from './changelog.ts';
import { cubeReferences } from './check-cube.ts';
import { bumpManifest, distTag, publishOrder, publishRefusal } from './release.ts';

const commit = (subject: string, body = ''): Commit => ({ hash: 'abc1234def', subject, body });

describe('changelog (F526)', () => {
  it('sorts the commits of a release into categories and marks breaking changes first', () => {
    const entry = changelogEntry('1.1.0', '2026-11-02', [
      commit('feat(core)!: rename GlobeOptions.view'),
      commit('fix: tiles stay black after a context loss'),
      commit('F503: lazily loaded optional modules'),
      commit('Engine: KB-133 boxed doubles in elevation queries'),
      commit('perf: fewer allocations per frame'),
      commit('docs: hosting guide'),
      commit('Renderer: new sampler', 'BREAKING CHANGE: the sampler option is gone'),
      commit("Merge branch 'main' into feature"),
    ]);
    expect(entry).toBe(
      [
        '## 1.1.0 (2026-11-02)\n',
        '### Breaking changes\n',
        '- **Breaking:** rename GlobeOptions.view (abc1234)',
        '- **Breaking:** Renderer: new sampler (abc1234)\n',
        '### Features\n',
        '- **Breaking:** rename GlobeOptions.view (abc1234)',
        '- F503: lazily loaded optional modules (abc1234)\n',
        '### Bug fixes\n',
        '- tiles stay black after a context loss (abc1234)',
        '- Engine: KB-133 boxed doubles in elevation queries (abc1234)\n',
        '### Performance\n',
        '- fewer allocations per frame (abc1234)\n',
        '### Documentation\n',
        '- hosting guide (abc1234)\n',
        '### Other changes\n',
        '- **Breaking:** Renderer: new sampler (abc1234)\n',
      ].join('\n'),
    );
  });

  it('keeps one entry per released version, newest first, and refuses a version twice', () => {
    const first = addEntry('', '1.0.0', changelogEntry('1.0.0', '2026-11-01', [commit('feat: globe')]));
    const second = addEntry(first, '1.1.0', changelogEntry('1.1.0', '2026-11-02', [commit('fix: tiles')]));
    expect(second.startsWith(CHANGELOG_HEADER)).toBe(true);
    expect(second.indexOf('## 1.1.0 (2026-11-02)')).toBeLessThan(second.indexOf('## 1.0.0 (2026-11-01)'));
    expect(() => addEntry(second, '1.0.0', '## 1.0.0 (x)\n')).toThrow(/already has an entry/);
  });
});

describe('release (F558)', () => {
  const ci = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'SimoneRecchia/VibeGlobe/.github/workflows/release.yml@refs/heads/main',
    NODE_AUTH_TOKEN: 'from-the-secret',
  };

  it('publishes only from the release workflow on main in CI, with the token from the CI secret', () => {
    expect(publishRefusal(ci)).toBeUndefined();
    expect(publishRefusal({ ...ci, CI: undefined, GITHUB_ACTIONS: undefined })).toMatch(/only from CI/);
    expect(publishRefusal({ ...ci, GITHUB_REF: 'refs/heads/feature' })).toMatch(/from main/);
    expect(publishRefusal({ ...ci, GITHUB_WORKFLOW_REF: 'x/.github/workflows/ci.yml@refs/heads/main' })).toMatch(
      /release\.yml/,
    );
    expect(publishRefusal({ ...ci, NODE_AUTH_TOKEN: '' })).toMatch(/NPM_TOKEN/);
  });

  it('gives every package the version, pins engine dependencies, and orders dependencies first', () => {
    const renderer = {
      devDependencies: { '@vibeglobe/sources': '0.0.0' },
      name: '@vibeglobe/renderer',
      version: '0.0.0',
      dependencies: { '@vibeglobe/core': '0.0.0', three: '0.186.1' },
    };
    expect(bumpManifest(renderer, '1.0.0-rc.1').devDependencies).toEqual({ '@vibeglobe/sources': '1.0.0-rc.1' });
    expect(bumpManifest(renderer, '1.0.0-rc.1').dependencies).toEqual({
      '@vibeglobe/core': '1.0.0-rc.1',
      three: '0.186.1',
    });
    expect(distTag('1.0.0-rc.1')).toBe('next');
    expect(distTag('1.0.0')).toBe('latest');
    expect(publishOrder([renderer, { name: '@vibeglobe/core', version: '0.0.0' }])).toEqual([
      '@vibeglobe/core',
      '@vibeglobe/renderer',
    ]);
  });

  it('holds publishing for the owner: the publish job runs in the approval environment with the npm secret', () => {
    const workflow = readFileSync(join(ROOT_DIR, '.github/workflows/release.yml'), 'utf8');
    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  post-release:'));
    expect(publishJob).toMatch(/needs: dry-run/);
    expect(publishJob).toMatch(/environment: npm-release/);
    expect(publishJob).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(publishJob).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    // The token appears nowhere else, and only the publish job runs the release with --publish.
    expect(workflow.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1);
    expect(workflow.match(/--publish/g)).toHaveLength(1);
    expect(publishJob).toMatch(/--publish/);
  });
});

describe('Cube search (F559)', () => {
  it('finds the consumer named in code or documentation, but not cube maps or test models', () => {
    const files = new Map([
      ['docs/guides/x.md', 'Consumers such as Cube serve assets.\ncube maps and MeshoptCubeTest.glb'],
      ['packages/core/src/a.ts', "import cube from '@vireox/cube';"],
      ['PLAN.md', 'The first consumer is Vireox Cube.'],
      ['docs/guides/integration.md', 'Integrating into Cube'],
    ]);
    expect(cubeReferences(files)).toEqual([
      'docs/guides/x.md:1: Consumers such as Cube serve assets.',
      "packages/core/src/a.ts:1: import cube from '@vireox/cube';",
    ]);
  });
});
