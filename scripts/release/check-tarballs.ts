// F530: packs every published package, inspects each tarball, then installs the tarballs into a strict TypeScript
// consumer outside the repository and type-checks it, failing on any file it reads from outside that project.
// Usage: node scripts/release/check-tarballs.ts (after npm run build).
import { cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, sep } from 'node:path';
import { ROOT_DIR } from '../workspace.ts';
import { extract, freshDir, inspectPackage, installTarballs, packAll } from './tarballs.ts';

const packed = packAll();
const unpacked = freshDir('unpacked');
let failed = false;
for (const pkg of packed) {
  const problems = inspectPackage(extract(pkg.tarball, join(unpacked, pkg.name.replace('/', '__'))));
  failed ||= problems.length > 0;
  console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${pkg.name}@${pkg.version}`);
  for (const problem of problems) console.error(`        ${problem}`);
}
rmSync(unpacked, { recursive: true, force: true });

const project = freshDir('strict-consumer');
cpSync(join(ROOT_DIR, 'examples/strict-consumer'), project, {
  recursive: true,
  filter: (path) => !path.includes(`${sep}node_modules`),
});
installTarballs(
  project,
  packed,
  packed.map((pkg) => pkg.name),
);
const tsc = join(ROOT_DIR, 'node_modules/typescript/bin/tsc');
const typescriptLib = dirname(join(ROOT_DIR, 'node_modules/typescript/lib/lib.d.ts'));
try {
  const listed = execFileSync('node', [tsc, '-p', project, '--listFiles'], { encoding: 'utf8' });
  const outside = listed
    .split('\n')
    .filter((file) => file !== '' && !file.startsWith(project + sep) && !file.startsWith(typescriptLib + sep));
  for (const file of outside) console.error(`FAIL  the consumer read ${file}, outside the project and its tarballs`);
  failed ||= outside.length > 0;
  if (outside.length === 0) console.log('ok    strict consumer type-checks against the tarballs alone');
} catch (error) {
  console.error((error as { stdout?: string }).stdout ?? error);
  console.error('FAIL  the strict consumer does not type-check against the tarballs');
  failed = true;
}
rmSync(project, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
