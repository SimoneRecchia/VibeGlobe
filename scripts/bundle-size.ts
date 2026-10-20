// Fails when a published package's minified and gzipped bundle exceeds its budget in quality/budgets.json.
// Each package is measured on its built `dist` with the other engine packages and `bundleExternal` left out.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundle } from './bundle.ts';
import { ROOT_DIR, readWorkspace } from './workspace.ts';

interface Budgets {
  bundleExternal: string[];
  packages: Record<string, { bundleGzipKB?: number }>;
}

const budgets = JSON.parse(readFileSync(join(ROOT_DIR, 'quality/budgets.json'), 'utf8')) as Budgets;
const published = readWorkspace().filter((pkg) => pkg.dir.startsWith('packages/') && !pkg.manifest.private);

let failed = false;
for (const pkg of published) {
  const name = pkg.manifest.name as string;
  const folder = pkg.dir.split('/')[1] as string;
  const budgetKB = budgets.packages[folder]?.bundleGzipKB;
  if (budgetKB === undefined) {
    console.error(`${name}: no bundleGzipKB budget in quality/budgets.json`);
    failed = true;
    continue;
  }
  if (!existsSync(join(ROOT_DIR, pkg.dir, 'dist/index.js'))) {
    console.error(`${name}: dist/index.js missing; run npm run build first`);
    failed = true;
    continue;
  }
  const external = (id: string): boolean =>
    (id.startsWith('@vibeglobe/') && id !== name) ||
    budgets.bundleExternal.some((dep) => id === dep || id.startsWith(`${dep}/`));
  const { gzipBytes } = await bundle(`export * from '${name}';`, external);
  const sizeKB = gzipBytes / 1024;
  const over = sizeKB > budgetKB;
  failed ||= over;
  console.log(
    `${over ? 'OVER' : 'ok  '}  ${name.padEnd(26)} ${sizeKB.toFixed(2).padStart(8)} KB gzip  (budget ${budgetKB} KB)`,
  );
}
if (failed) process.exit(1);
