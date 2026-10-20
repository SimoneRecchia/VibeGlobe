// Checks the built packages the way consumers use them: every package imports from a Node ES module through its
// exports map (resolving dist/, not sources), and a strict TypeScript consumer type-checks against the declarations.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT_DIR, readWorkspace } from './workspace.ts';

const published = readWorkspace().filter((pkg) => pkg.dir.startsWith('packages/') && !pkg.manifest.private);
for (const pkg of published) {
  const name = pkg.manifest.name as string;
  const resolved = import.meta.resolve(name);
  if (!resolved.includes(`/${pkg.dir}/dist/`)) throw new Error(`${name} resolves to ${resolved}, not its dist/ build`);
  await import(name);
  console.log(`ok    import '${name}' → ${resolved.slice(resolved.indexOf(pkg.dir))}`);
}

const tsc = join(ROOT_DIR, 'node_modules/.bin/tsc');
execFileSync(tsc, ['-p', join(ROOT_DIR, 'scripts/fixtures/consumer/tsconfig.json')], { stdio: 'inherit' });
console.log('ok    strict consumer type-checks against the published declarations');
