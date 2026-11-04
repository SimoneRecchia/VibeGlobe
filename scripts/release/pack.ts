// Packs the single `vibeglobe` package of the checked-out version into `release-<version>/`, for installing it from the
// file before it is on the registry. Run after `npm run build`. Publishes nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../workspace.ts';
import { packAll } from './tarballs.ts';

const { version } = JSON.parse(readFileSync(join(ROOT_DIR, 'packages/vibeglobe/package.json'), 'utf8')) as {
  version: string;
};
const outDir = join(ROOT_DIR, `release-${version}`);
for (const { name, tarball } of packAll(outDir)) console.log(`${name}: ${tarball}`);
