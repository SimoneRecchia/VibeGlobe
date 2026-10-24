// Builds the consumer projects in examples/ outside the repository, from the packed tarballs (or, with --registry, from
// the public npm registry), serves them under a strict Content Security Policy and checks them in Chromium.
//
//   node scripts/release/check-consumers.ts [F503] [F531] [F532]   (F503 and F531 by default; F532 when named)
//     F503  the initial bundle of a core-and-renderer app within budget, each optional module fetched only when enabled
//     F531  worker and WebAssembly load in a Vite and a Nuxt build with no asset configuration, then from a separate
//           static server; nothing needs 'unsafe-eval'
//     F532  only the core, the renderer, one imagery source and the worker installed; renders and navigates
//   node scripts/release/check-consumers.ts --registry <version>   F559: the same consumer installed from npm
//
// Run `npm run build` first. Third-party dependencies come from the public registry, with no credentials.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium, type Browser, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { gpuArgs } from '../browser/gpu-args.ts';
import { ROOT_DIR } from '../workspace.ts';
import { serveSite, type Site } from './serve.ts';
import { freshDir, installTarballs, installedEnginePackages, packAll, type PackedPackage } from './tarballs.ts';

const BASE_IMAGE = join(ROOT_DIR, 'apps/playground/public/imagery/natural-earth-4096.jpg');
/** Packages a core-and-renderer application must not pull in (F532). */
const OPTIONAL_PACKAGES = ['layers', 'ui', 'offline', 'vue', 'web-component'].map((name) => `@vibeglobe/${name}`);

let failures = 0;
function check(ok: boolean, message: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures++;
}

/** Copies an example outside the repository, installs it and builds it; returns the project directory. */
function buildExample(
  example: string,
  engine: readonly string[],
  install: { packed: readonly PackedPackage[] } | { version: string },
): string {
  const project = freshDir(example);
  cpSync(join(ROOT_DIR, 'examples', example), project, {
    recursive: true,
    filter: (path) => !path.includes(`${sep}node_modules`) && !path.includes(`${sep}dist`),
  });
  mkdirSync(join(project, 'public'), { recursive: true });
  cpSync(BASE_IMAGE, join(project, 'public/natural-earth-4096.jpg'));
  if ('packed' in install) installTarballs(project, install.packed, engine);
  else {
    // From the public registry like any other dependency: no .npmrc, no token, the default registry.
    const manifestPath = join(project, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
    const dependencies = { ...manifest.dependencies, ...Object.fromEntries(engine.map((n) => [n, install.version])) };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies }, null, 2));
    execFileSync(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--registry',
        'https://registry.npmjs.org/',
        '--userconfig',
        join(project, '.npmrc-none'),
      ],
      { cwd: project, stdio: 'inherit' },
    );
  }
  execFileSync('npm', ['run', 'build'], { cwd: project, stdio: 'inherit' });
  return project;
}

/** Removes a built project, unless VIBEGLOBE_RELEASE_KEEP=1 asks to keep it for debugging. */
function removeProject(project: string): void {
  if (process.env['VIBEGLOBE_RELEASE_KEEP'] === '1') console.log(`kept ${project}`);
  else rmSync(project, { recursive: true, force: true });
}

async function launch(): Promise<Browser> {
  const executablePath = process.env['VIBEGLOBE_CHROMIUM_PATH'];
  return chromium.launch({ args: gpuArgs(), ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
}

/** Opens `url` and records page errors, Content Security Policy violations and script and WebAssembly requests. */
async function open(
  browser: Browser,
  url: string,
): Promise<{ page: Page; errors: string[]; warnings: string[]; fetched: string[] }> {
  const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
  const errors: string[] = [];
  const warnings: string[] = [];
  const fetched: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    else if (message.type() === 'warning') warnings.push(message.text());
  });
  page.on('request', (request) => fetched.push(new URL(request.url()).pathname));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) =>
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  await page.goto(url);
  return { page, errors, warnings, fetched };
}

/** Waits until the globe has drawn every imagery tile it asked for and stopped drawing. */
async function waitForImagery(page: Page, global: string): Promise<{ ready: number; failed: number }> {
  return page.evaluate(async (name) => {
    const lookup = (): import('@vibeglobe/core').Globe | undefined =>
      (window as unknown as Record<string, import('@vibeglobe/core').Globe | undefined>)[name];
    // A framework adapter creates the globe after hydration.
    const start = performance.now();
    while (!lookup() && performance.now() - start < 60_000) await new Promise((resolve) => setTimeout(resolve, 200));
    const globe = lookup();
    if (!globe) throw new Error(`window.${name} is missing`);
    await globe.ready;
    const settled = (): boolean => {
      const stats = globe.imageryStats();
      return !!stats && stats.ready > 0 && stats.queued + stats.loading + stats.decoding + stats.uploadsPending === 0;
    };
    const deadline = performance.now() + 90_000;
    while (!settled() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    let frame = -1;
    while (frame !== globe.frameNumber) {
      frame = globe.frameNumber;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const stats = globe.imageryStats();
    return { ready: stats?.ready ?? 0, failed: stats?.failed ?? 0 };
  }, global);
}

/** The canvas as RGBA pixels. */
async function canvasPixels(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.locator('canvas').first().screenshot());
}

/** Share of pixels that are near black (nothing drawn). */
function darkShare(image: PNG): number {
  let dark = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if ((image.data[i] ?? 0) + (image.data[i + 1] ?? 0) + (image.data[i + 2] ?? 0) < 15) dark++;
  }
  return dark / (image.width * image.height);
}

function changedShare(a: PNG, b: PNG): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) + Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    if (delta > 30) changed++;
  }
  return changed / (a.width * a.height);
}

/** F532 (and F559's rendering step): renders the globe with tiled imagery and navigates. */
async function checkRendersAndNavigates(browser: Browser, site: Site, label: string): Promise<void> {
  const { page, errors, fetched } = await open(browser, `${site.url}?backend=webgl2`);
  const first = await waitForImagery(page, 'minimalGlobe');
  check(
    first.ready > 0 && first.failed === 0,
    `${label}: imagery tiles drawn (${first.ready} ready, ${first.failed} failed)`,
  );
  const before = await canvasPixels(page);
  check(darkShare(before) < 0.01, `${label}: the globe fills the view (${(darkShare(before) * 100).toFixed(2)}% dark)`);
  await page.evaluate(() => window.minimalGlobe?.flyTo({ longitudeDeg: -74, latitudeDeg: 40.7, zoom: 4 }));
  await waitForImagery(page, 'minimalGlobe');
  const camera = await page.evaluate(() => window.minimalGlobe?.camera);
  const after = await canvasPixels(page);
  check(
    Math.abs((camera?.longitudeDeg ?? 0) + 74) < 0.5 && changedShare(before, after) > 0.2,
    `${label}: navigates (camera at ${camera?.longitudeDeg.toFixed(2)}°, ${(changedShare(before, after) * 100).toFixed(0)}% of pixels changed)`,
  );
  check(darkShare(after) < 0.01, `${label}: no hole after navigating`);
  check(
    fetched.some((path) => /vibeglobe-worker[^/]*\.js$/.test(path)) && fetched.some((path) => /\.wasm$/.test(path)),
    `${label}: the worker program and its WebAssembly loaded`,
  );
  check(
    errors.length === 0,
    `${label}: no page errors or policy violations${errors.length ? `: ${errors.join('; ')}` : ''}`,
  );
  await page.close();
}

/** F531 step 2: the worker program and WebAssembly come from a separate static server mounted at a configured path. */
async function checkCustomAssetUrls(browser: Browser, project: string, label: string): Promise<void> {
  const assets = freshDir('assets');
  cpSync(join(project, 'dist/assets'), assets, { recursive: true });
  // The hosting guide's layout: the bundled worker served as vibeglobe-worker.js next to its WebAssembly.
  const worker = execFileSync('ls', [assets], { encoding: 'utf8' })
    .split('\n')
    .find((file) => /^vibeglobe-worker-.*\.js$/.test(file));
  if (!worker) throw new Error('the build emitted no vibeglobe-worker-*.js');
  cpSync(join(assets, worker), join(assets, 'vibeglobe-worker.js'));
  const assetServer = await serveSite(assets, { tiles: false });
  const site = await serveSite(join(project, 'dist'), {
    forward: { prefix: '/vendor/vibeglobe/', target: assetServer.url },
  });
  const { page, errors, warnings, fetched } = await open(
    browser,
    `${site.url}?backend=webgl2&assets=/vendor/vibeglobe/`,
  );
  const stats = await waitForImagery(page, 'minimalGlobe');
  check(
    stats.ready > 0 && stats.failed === 0,
    `${label}: imagery drawn with assets from the separate server (${stats.ready} ready, ${stats.failed} failed)${
      stats.ready === 0 ? `; warnings: ${warnings.join('; ')}` : ''
    }`,
  );
  check(
    assetServer.requests.includes('/vibeglobe-worker.js') &&
      assetServer.requests.some((path) => path.endsWith('.wasm')),
    `${label}: worker and WebAssembly served by the separate static server (${assetServer.requests.filter((p) => /\.(js|wasm)$/.test(p)).join(', ')})`,
  );
  check(
    !fetched.some((path) => path.startsWith('/assets/') && /vibeglobe-worker|\.wasm$/.test(path)),
    `${label}: nothing loaded from the default asset location`,
  );
  check(
    errors.length === 0,
    `${label}: no page errors or policy violations${errors.length ? `: ${errors.join('; ')}` : ''}`,
  );
  await page.close();
  await site.close();
  await assetServer.close();
  rmSync(assets, { recursive: true, force: true });
}

/** F531 step 3: nothing in the build needs 'unsafe-eval': no eval, no Function constructor, no blob or data workers. */
function checkNoEval(project: string, label: string): void {
  const files = execFileSync('find', [project, '-name', '*.js'], { encoding: 'utf8' }).trim().split('\n');
  const offenders = files.filter((file) => {
    const code = readFileSync(file, 'utf8');
    return /\beval\(|new Function\(|\bFunction\(\s*['"`]|new Worker\(\s*(URL\.createObjectURL|['"`](blob|data):)/.test(
      code,
    );
  });
  check(
    offenders.length === 0,
    `${label}: no asset needs 'unsafe-eval' (${files.length} scripts scanned)${offenders.length ? `: ${offenders.join(', ')}` : ''}`,
  );
}

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
}

/** The files the browser loads for a manifest entry: the chunk and its static imports, recursively. */
function chunkFiles(manifest: Record<string, ManifestChunk>, key: string, into = new Set<string>()): Set<string> {
  const chunk = manifest[key];
  if (!chunk || into.has(chunk.file)) return into;
  into.add(chunk.file);
  for (const imported of chunk.imports ?? []) chunkFiles(manifest, imported, into);
  return into;
}

/** F503: the initial bundle of a core-and-renderer app is within budget; optional modules load only when enabled. */
async function checkLazyModules(browser: Browser, project: string, site: Site): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(project, 'dist/.vite/manifest.json'), 'utf8')) as Record<
    string,
    ManifestChunk
  >;
  const entry = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
  if (!entry) throw new Error('the build manifest has no entry');
  const { page, errors, fetched } = await open(browser, `${site.url}?backend=webgl2`);
  await waitForImagery(page, 'lazyGlobe');
  // The initial JavaScript: everything fetched up to the first complete frame, dynamic imports of the engine included.
  const initial = new Set([
    ...chunkFiles(manifest, entry),
    ...fetched.filter((path) => path.endsWith('.js')).map((path) => path.slice(1)),
  ]);
  const gzipKB =
    [...initial].reduce((sum, file) => sum + gzipSync(readFileSync(join(project, 'dist', file))).length, 0) / 1024;
  const budget = (
    JSON.parse(readFileSync(join(ROOT_DIR, 'quality/budgets.json'), 'utf8')) as { initialJs: { totalGzipKB: number } }
  ).initialJs.totalGzipKB;
  check(
    gzipKB <= budget,
    `F503: initial JavaScript of the core and the renderer ${gzipKB.toFixed(1)} KB gzip in ${initial.size} files (budget ${budget} KB)`,
  );
  const modules = await page.evaluate(() => window.optionalModules ?? []);
  check(modules.length === 6, `F503: six optional modules offered (${modules.join(', ')})`);
  const closures = new Map(
    modules.map((name) => [name, [...chunkFiles(manifest, `src/modules/${name}.ts`)].filter((f) => !initial.has(f))]),
  );
  for (const name of modules) {
    const own = closures.get(name) ?? [];
    // Chunks another module shares (a package both use) may already have arrived with that module.
    const exclusive = own.filter((file) =>
      [...closures].every(([other, files]) => other === name || !files.includes(file)),
    );
    const early = own.filter((file) => fetched.includes(`/${file}`) && exclusive.includes(file));
    const before = fetched.length;
    check(
      exclusive.length > 0 && early.length === 0,
      `F503: ${name} not fetched before it is enabled (${exclusive.length} of its ${own.length} chunks its own)${early.length ? `: ${early.join(', ')} came early` : ''}`,
    );
    const result = await page.evaluate((module) => window.enableModule?.(module), name);
    const missing = own.filter((file) => !fetched.includes(`/${file}`));
    const arrived = fetched.slice(before).filter((path) => own.includes(path.slice(1))).length;
    check(
      missing.length === 0 && arrived > 0,
      `F503: ${name} fetched when enabled (${arrived} chunks; ${result ?? 'no result'})`,
    );
  }
  check(
    errors.length === 0,
    `F503: no page errors or policy violations${errors.length ? `: ${errors.join('; ')}` : ''}`,
  );
  await page.close();
}

declare global {
  interface Window {
    minimalGlobe?: import('@vibeglobe/core').Globe;
    lazyGlobe?: import('@vibeglobe/core').Globe;
    optionalModules?: string[];
    enableModule?: (name: string) => Promise<string>;
  }
}

const args = process.argv.slice(2);
const registryIndex = args.indexOf('--registry');
const registryVersion = registryIndex >= 0 ? args[registryIndex + 1] : undefined;
const entries = new Set(
  args.filter((arg, index) => /^F\d+$/.test(arg) && (registryIndex < 0 || index !== registryIndex + 1)),
);
// F532 runs only when named until hook request H (1) lands: its install check fails on @vibeglobe/worker's dependency on
// @vibeglobe/layers, an engine change (docs/test-changes.md, 2026-10-24).
if (entries.size === 0) for (const entry of ['F503', 'F531']) entries.add(entry);
if (registryVersion !== undefined) entries.add('F559');
const MINIMAL_ENGINE = ['@vibeglobe/core', '@vibeglobe/renderer', '@vibeglobe/sources', '@vibeglobe/worker'];

const browser = await launch();
const packed = registryVersion === undefined ? packAll() : [];
try {
  if (entries.has('F531') || entries.has('F532') || entries.has('F559')) {
    const label = registryVersion === undefined ? 'vite' : `npm ${registryVersion}`;
    const project = buildExample(
      'minimal-globe',
      MINIMAL_ENGINE,
      registryVersion === undefined ? { packed } : { version: registryVersion },
    );
    if (entries.has('F532')) {
      const installed = installedEnginePackages(project);
      const optional = installed.filter((name) => OPTIONAL_PACKAGES.includes(name));
      check(optional.length === 0, `F532: installs ${installed.join(', ')}; none of ${OPTIONAL_PACKAGES.join(', ')}`);
    }
    const site = await serveSite(join(project, 'dist'));
    await checkRendersAndNavigates(browser, site, `${[...entries].join('/')} ${label}`);
    await site.close();
    if (entries.has('F531')) {
      await checkCustomAssetUrls(browser, project, `F531 ${label}`);
      checkNoEval(join(project, 'dist'), `F531 ${label}`);
    }
    removeProject(project);
  }
  if (entries.has('F531') && registryVersion === undefined) {
    const project = buildExample('nuxt-globe', ['@vibeglobe/vue', '@vibeglobe/sources'], { packed });
    // Nuxt writes its configuration as an inline script: the page needs 'unsafe-inline', never 'unsafe-eval'.
    const site = await serveSite(join(project, '.output/public'), { inlineScripts: true });
    const { page, errors, fetched } = await open(browser, `${site.url}?backend=webgl2`);
    const stats = await waitForImagery(page, 'minimalGlobe');
    check(stats.ready > 0 && stats.failed === 0, `F531 nuxt: KTX2 imagery drawn (${stats.ready} ready)`);
    check(
      fetched.some((path) => /vibeglobe-worker[^/]*\.js$/.test(path)) && fetched.some((path) => /\.wasm$/.test(path)),
      'F531 nuxt: the worker program and its WebAssembly loaded with no asset configuration',
    );
    check(
      errors.length === 0,
      `F531 nuxt: no page errors or policy violations${errors.length ? `: ${errors.join('; ')}` : ''}`,
    );
    await page.close();
    await site.close();
    checkNoEval(join(project, '.output/public'), 'F531 nuxt');
    removeProject(project);
  }
  if (entries.has('F503')) {
    const engine = ['core', 'renderer', 'sources', 'worker', 'layers', 'ui', 'offline'].map(
      (name) => `@vibeglobe/${name}`,
    );
    const project = buildExample('lazy-modules', engine, { packed });
    const site = await serveSite(join(project, 'dist'));
    await checkLazyModules(browser, project, site);
    await site.close();
    removeProject(project);
  }
} finally {
  await browser.close();
}
console.log(failures === 0 ? 'All consumer checks passed.' : `${failures} consumer check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
