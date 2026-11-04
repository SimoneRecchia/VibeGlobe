// The release (F709, ADR 0190, ADR 0191): builds the engine, packs `vibeglobe` at the version given and publishes it to
// the public npm registry through npm's trusted publishing (the workflow's OIDC identity, no token), nothing else. Only
// in the release workflow on main.
//
//   node scripts/release/release.ts <version>
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../workspace.ts';
import { packAll } from './tarballs.ts';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Why publishing is refused in this environment, or undefined when it may go ahead. */
export function publishRefusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env['CI'] !== 'true' || env['GITHUB_ACTIONS'] !== 'true')
    return 'packages are published only from CI (the release workflow), never from a workstation';
  if (env['GITHUB_REF'] !== 'refs/heads/main') return `releases are published from main, not ${env['GITHUB_REF']}`;
  if (env['GITHUB_WORKFLOW_REF']?.includes('/.github/workflows/release.yml@') !== true)
    return 'packages are published only by .github/workflows/release.yml';
  if (!env['ACTIONS_ID_TOKEN_REQUEST_URL'])
    return "no OIDC identity: npm's trusted publishing needs the workflow's `id-token: write` permission";
  return undefined;
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
  const [version] = process.argv.slice(2);
  if (!version || !SEMVER.test(version)) throw new Error('usage: node scripts/release/release.ts <semantic version>');
  const refusal = publishRefusal(process.env);
  if (refusal) throw new Error(`refusing to publish: ${refusal}`);
  run('npx', ['tsc', '-b']);
  run('npm', ['run', 'build:browser', '-w', '@vibeglobe/web-component']);
  const [packed] = packAll(undefined, ROOT_DIR, version);
  if (!packed) throw new Error('nothing was packed');
  // npm attaches the provenance itself when it publishes through a trusted publisher.
  run('npm', ['publish', packed.tarball, '--access', 'public', '--tag', distTag(version)]);
}
