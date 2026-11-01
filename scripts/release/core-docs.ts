// The guides travel with @vibeglobe/core, which every application installs, so an agent reads the ones matching the
// installed version from node_modules: copied before `npm pack`, removed after it (`--remove`).
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../workspace.ts';

const core = join(ROOT_DIR, 'packages/core');
for (const path of ['docs', 'llms.txt']) rmSync(join(core, path), { recursive: true, force: true });
if (!process.argv.includes('--remove')) {
  cpSync(join(ROOT_DIR, 'docs/guides'), join(core, 'docs/guides'), { recursive: true });
  cpSync(join(ROOT_DIR, 'docs/data-licenses.md'), join(core, 'docs/data-licenses.md'));
  cpSync(join(ROOT_DIR, 'llms.txt'), join(core, 'llms.txt'));
}
