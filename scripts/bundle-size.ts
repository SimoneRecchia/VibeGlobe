// Fails when a published package's minified and gzipped bundle exceeds its budget in quality/budgets.json.
// Each package is measured on its built `dist` with the other engine packages and `bundleExternal` left out.
// Then the initial JavaScript of a minimal globe (everything loaded before its first frame, dynamic imports included)
// is checked against `initialJs`: three.js's share after tree-shaking, and the total (F546, ADR 0010).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bundle } from './bundle.ts';
import { ROOT_DIR, readWorkspace } from './workspace.ts';

interface Budgets {
  bundleExternal: string[];
  initialJs: { threeGzipKB: number; totalGzipKB: number };
  packages: Record<string, { bundleGzipKB?: number }>;
  /** Lazily loaded WebAssembly binaries (ADR 0020 rule 4). */
  wasm: Record<string, { file: string; gzipKB: number }>;
}

/** A minimal host page's globe: the engine packages a first frame needs. */
const MINIMAL_GLOBE = `import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { createControls } from '@vibeglobe/controls';
createGlobe({ container: document.body, renderer: createRenderer(), controls: createControls(), baseImageryUrl: 'a.jpg' });`;

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
const isThree = (id: string): boolean => id === 'three' || id.startsWith('three/');
const total = (await bundle(MINIMAL_GLOBE)).gzipBytes / 1024;
const three = total - (await bundle(MINIMAL_GLOBE, isThree)).gzipBytes / 1024;
for (const [label, sizeKB, budgetKB] of [
  ['initial JavaScript, three.js share', three, budgets.initialJs.threeGzipKB],
  ['initial JavaScript, total', total, budgets.initialJs.totalGzipKB],
] as const) {
  const over = sizeKB > budgetKB;
  failed ||= over;
  console.log(
    `${over ? 'OVER' : 'ok  '}  ${label.padEnd(36)} ${sizeKB.toFixed(2).padStart(8)} KB gzip  (budget ${budgetKB} KB)`,
  );
}
for (const [name, { file, gzipKB }] of Object.entries(budgets.wasm)) {
  const sizeKB = gzipSync(readFileSync(join(ROOT_DIR, file)), { level: 9 }).length / 1024;
  const over = sizeKB > gzipKB;
  failed ||= over;
  console.log(
    `${over ? 'OVER' : 'ok  '}  ${`${name}.wasm (lazy)`.padEnd(36)} ${sizeKB.toFixed(2).padStart(8)} KB gzip  (budget ${gzipKB} KB)`,
  );
}
if (failed) process.exit(1);
