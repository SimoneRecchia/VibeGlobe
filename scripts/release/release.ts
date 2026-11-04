// The release (F704, ADR 0171, ADR 0189): sets one version on every engine package, adds the changelog entry, builds,
// packs and checks the single `vibeglobe` package, commits, tags and publishes it to the public npm registry.
//
//   node scripts/release/release.ts <version>             dry run (default): in a temporary git worktree, so this
//                                                         checkout is untouched; `npm publish --dry-run`; the tag is
//                                                         created, verified and deleted, nothing is pushed
//   node scripts/release/release.ts <version> --publish   only in the release workflow's approved publish job on main
//                                                         (CI, GitHub Actions, the npm token from a CI secret)
//
// The report of the run is written to .release/report.json and the changelog entry to .release/CHANGELOG-entry.md.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../workspace.ts';
import { writeChangelog } from './changelog.ts';
import { packAll } from './tarballs.ts';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SCOPE = '@vibeglobe/';
/** The one package published (ADR 0189). */
const PACKAGE = 'vibeglobe';

/** Why publishing is refused in this environment, or undefined when it may go ahead (F558). */
export function publishRefusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env['CI'] !== 'true' || env['GITHUB_ACTIONS'] !== 'true')
    return 'packages are published only from CI (the release workflow), never from a workstation';
  if (env['GITHUB_REF'] !== 'refs/heads/main') return `releases are published from main, not ${env['GITHUB_REF']}`;
  if (env['GITHUB_WORKFLOW_REF']?.includes('/.github/workflows/release.yml@') !== true)
    return 'packages are published only by .github/workflows/release.yml';
  if (!env['NODE_AUTH_TOKEN']) return 'NODE_AUTH_TOKEN is not set: the npm token comes from the NPM_TOKEN CI secret';
  return undefined;
}

/** The npm dist-tag of a version: pre-releases go to `next`, so `latest` keeps the last stable release. */
export function distTag(version: string): 'latest' | 'next' {
  return version.includes('-') ? 'next' : 'latest';
}

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Sets `version` on a published package and pins its engine dependencies to the same version. */
export function bumpManifest(manifest: Manifest, version: string): Manifest {
  const pin = (deps: Record<string, string> | undefined): Record<string, string> | undefined =>
    deps &&
    Object.fromEntries(Object.entries(deps).map(([name, range]) => [name, name.startsWith(SCOPE) ? version : range]));
  const dependencies = pin(manifest.dependencies);
  const peerDependencies = pin(manifest.peerDependencies);
  // Development dependencies on engine packages too, or npm would look for the old version in the registry.
  const devDependencies = pin(manifest.devDependencies);
  return {
    ...manifest,
    version,
    ...(dependencies ? { dependencies } : {}),
    ...(peerDependencies ? { peerDependencies } : {}),
    ...(devDependencies ? { devDependencies } : {}),
  };
}

function run(cwd: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  console.log(`$ ${command} ${args.join(' ')}`);
  const output = execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  // Machine-readable answers are parsed by the caller; everything else is the step's log.
  if (!args.includes('--json') && command !== 'git') process.stdout.write(output);
  return output;
}

function readManifests(cwd: string): { path: string; manifest: Manifest }[] {
  return execFileSync('git', ['ls-files', 'packages/*/package.json'], { cwd, encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((path) => ({
      path: join(cwd, path),
      manifest: JSON.parse(readFileSync(join(cwd, path), 'utf8')) as Manifest,
    }));
}

interface Publication {
  name: string;
  version: string;
  tag: string;
  access: string;
  registry: string;
  files: number;
}

const REGISTRY = 'https://registry.npmjs.org/';

/** Steps 1–4 in `cwd`: versions, changelog entry, build and tarball check, release commit and tag; returns the commit. */
function prepare(
  cwd: string,
  version: string,
  reportDir: string,
): { manifests: { path: string; manifest: Manifest }[]; commit: string } {
  if (run(cwd, 'git', ['status', '--porcelain']).trim() !== '') throw new Error('the working tree is not clean');
  const tag = `v${version}`;
  // 1. Version: one version for every engine package, their dependencies on each other pinned to it.
  const manifests = readManifests(cwd);
  for (const { path, manifest } of manifests)
    writeFileSync(path, `${JSON.stringify(bumpManifest(manifest, version), null, 2)}\n`);
  // 2. Changelog entry from the commits since the last release tag.
  const entry = writeChangelog(version, new Date().toISOString().slice(0, 10), cwd);
  writeFileSync(join(reportDir, 'CHANGELOG-entry.md'), entry);
  // 3. Build and check what is published (F530); the lockfile records the new versions.
  run(cwd, 'npm', ['install', '--package-lock-only', '--no-audit', '--no-fund']);
  run(cwd, 'npm', ['ci', '--no-audit', '--no-fund']);
  run(cwd, 'npx', ['prettier', '--write', 'CHANGELOG.md', 'package-lock.json', 'packages/*/package.json']);
  run(cwd, 'npx', ['tsc', '-b']);
  run(cwd, 'npm', ['run', 'build:browser', '-w', '@vibeglobe/web-component']);
  run(cwd, 'node', ['scripts/release/check-tarballs.ts']);
  // 4. Release commit and annotated tag.
  const identity = ['-c', 'user.name=VibeGlobe release', '-c', 'user.email=release@vibeglobe.invalid'];
  run(cwd, 'git', ['add', 'CHANGELOG.md', 'package-lock.json', ...manifests.map(({ path }) => path)]);
  run(cwd, 'git', [...identity, 'commit', '--quiet', '-m', `Release ${tag}`]);
  run(cwd, 'git', [...identity, 'tag', '-a', tag, '-m', `Release ${tag}`]);
  const commit = run(cwd, 'git', ['rev-list', '-n', '1', tag]).trim();
  if (commit !== run(cwd, 'git', ['rev-parse', 'HEAD']).trim())
    throw new Error(`${tag} does not point at the release commit`);
  return { manifests, commit };
}

/** Step 5: the single package, packed from the release commit, to the public registry (`--dry-run` unless publishing). */
function publishPackage(cwd: string, version: string, publish: boolean): Publication {
  const [packed] = packAll(join(cwd, '.release/tarballs'), cwd);
  if (!packed) throw new Error('nothing was packed');
  const args = ['publish', packed.tarball, '--access', 'public', '--tag', distTag(version), '--registry', REGISTRY];
  args.push('--json', publish ? '--provenance' : '--dry-run');
  const result = JSON.parse(run(cwd, 'npm', args)) as { name: string; version: string; entryCount: number };
  if (result.name !== PACKAGE || result.version !== version)
    throw new Error(`npm would publish ${result.name}@${result.version}, not ${PACKAGE}@${version}`);
  return {
    name: PACKAGE,
    version,
    tag: distTag(version),
    access: 'public',
    registry: REGISTRY,
    files: result.entryCount,
  };
}

function release(version: string, publish: boolean): void {
  if (!SEMVER.test(version)) throw new Error(`${version} is not a semantic version`);
  const refusal = publish ? publishRefusal(process.env) : undefined;
  if (refusal) throw new Error(`refusing to publish: ${refusal}`);
  const tag = `v${version}`;
  if (run(ROOT_DIR, 'git', ['tag', '--list', tag]).trim() !== '') throw new Error(`the tag ${tag} already exists`);
  // A dry run works in a temporary worktree of HEAD, so the developer's checkout and branch stay as they are.
  const cwd = publish ? ROOT_DIR : join(tmpdir(), `vibeglobe-release-${version}`);
  if (!publish) {
    rmSync(cwd, { recursive: true, force: true });
    run(ROOT_DIR, 'git', ['worktree', 'add', '--detach', cwd, 'HEAD']);
  }
  const reportDir = join(ROOT_DIR, '.release');
  mkdirSync(reportDir, { recursive: true });
  try {
    const { commit } = prepare(cwd, version, reportDir);
    const publications = [publishPackage(cwd, version, publish)];
    if (publish) run(cwd, 'git', ['push', 'origin', 'HEAD:refs/heads/main', tag]);
    const report = { version, tag, commit, dryRun: !publish, publications };
    writeFileSync(join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (!publish) cpSync(join(cwd, 'CHANGELOG.md'), join(reportDir, 'CHANGELOG.md'));
    console.log(`\n${publish ? 'Published' : 'Dry run of'} ${tag}: ${PACKAGE}, dist-tag ${distTag(version)}`);
    for (const { name, files } of publications) console.log(`  ${name}@${version} (${files} files, public)`);
  } finally {
    if (!publish) {
      // The tag lives in the shared repository: a dry run leaves none behind.
      if (run(ROOT_DIR, 'git', ['tag', '--list', tag]).trim() !== '') run(ROOT_DIR, 'git', ['tag', '-d', tag]);
      run(ROOT_DIR, 'git', ['worktree', 'remove', '--force', cwd]);
      if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const [version] = process.argv.slice(2);
  if (!version || version.startsWith('--'))
    throw new Error('usage: node scripts/release/release.ts <version> [--publish]');
  release(version, process.argv.includes('--publish'));
}
