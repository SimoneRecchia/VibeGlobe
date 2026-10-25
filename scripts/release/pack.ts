// Packs every published package of the checked-out version into `release-<version>/` for installing from files, as
// the 0.1.0 pre-release is (owner, 2026-10-25; release-0.1.0/README.md). Run after `npm run build`. Publishes nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../workspace.ts';
import { packAll } from './tarballs.ts';

const { version } = JSON.parse(readFileSync(join(ROOT_DIR, 'packages/core/package.json'), 'utf8')) as {
  version: string;
};
const outDir = join(ROOT_DIR, `release-${version}`);
for (const { name, tarball } of packAll(outDir)) console.log(`${name}: ${tarball}`);
