// The release (F710, ADR 0190, ADR 0191, ADR 0192): when a GitHub release is published, builds the engine, packs
// `vibeglobe` at the version of the release's tag and publishes it to the public npm registry through npm's trusted
// publishing (the workflow's OIDC identity, no token), nothing else.
//
//   node scripts/release/release.ts <tag>          v1.2.3 or 1.2.3
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../workspace.ts';
import { packAll } from './tarballs.ts';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Why publishing is refused in this environment, or undefined when it may go ahead. */
export function publishRefusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env['CI'] !== 'true' || env['GITHUB_ACTIONS'] !== 'true')
    return 'packages are published only from CI (the release workflow), never from a workstation';
  if (env['GITHUB_EVENT_NAME'] !== 'release')
    return `packages are published only for a GitHub release, not a ${env['GITHUB_EVENT_NAME']} event`;
  if (env['GITHUB_WORKFLOW_REF']?.includes('/.github/workflows/release.yml@') !== true)
    return 'packages are published only by .github/workflows/release.yml';
  if (!env['ACTIONS_ID_TOKEN_REQUEST_URL'])
    return "no OIDC identity: npm's trusted publishing needs the workflow's `id-token: write` permission";
  return undefined;
}

/** The version a release's tag names: `v1.2.3` or `1.2.3`, a semantic version. */
export function versionOf(tag: string): string {
  const version = tag.replace(/^v/, '');
  if (!SEMVER.test(version)) throw new Error(`the release's tag ${tag} is not v<semantic version>, such as v1.2.3`);
  return version;
}

/** The npm dist-tag of a version: pre-releases go to `next`, so `latest` keeps the last stable release. */
export function distTag(version: string): 'latest' | 'next' {
  return version.includes('-') ? 'next' : 'latest';
}

function run(command: string, args: readonly string[]): void {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: ROOT_DIR, stdio: 'inherit' });
}

if (import.meta.main) {
  const version = versionOf(process.argv[2] ?? '');
  const refusal = publishRefusal(process.env);
  if (refusal) throw new Error(`refusing to publish: ${refusal}`);
  run('npx', ['tsc', '-b']);
  run('npm', ['run', 'build:browser', '-w', '@vibeglobe/web-component']);
  const [packed] = packAll(undefined, ROOT_DIR, version);
  if (!packed) throw new Error('nothing was packed');
  // npm attaches the provenance itself when it publishes through a trusted publisher.
  run('npm', ['publish', packed.tarball, '--access', 'public', '--tag', distTag(version)]);
}
