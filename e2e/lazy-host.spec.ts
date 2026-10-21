import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { canvasImage } from './support/globe.ts';

/** The fixture host application (apps/lazy-host), served from its production build. */
const LAZY_HOST = `http://localhost:${process.env['LAZY_HOST_PORT'] ?? 5175}/`;
const DIST = new URL('../apps/lazy-host/dist/', import.meta.url);
const MANIFEST = new URL('.vite/manifest.json', DIST);
/** Strings only engine or three.js code contains: error codes of the core and the renderer, three.js log prefixes. */
const ENGINE_CODE = /invalid-option|unsupported-device|THREE\./;

interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
}

/** The files the browser loads before any dynamic import: the entry and its static imports, recursively. */
function staticFiles(manifest: Record<string, ManifestChunk>): Set<string> {
  const files = new Set<string>();
  const visit = (key: string): void => {
    const chunk = manifest[key];
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
  return files;
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`a host app loads the engine only after a user action, then the globe renders on ${backend} (F547)`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, ManifestChunk>;
    const initial = staticFiles(manifest);
    // Build output: nothing loaded before the action comes from an engine package or three.js.
    const engineChunks = Object.values(manifest).filter((chunk) => chunk.src?.includes('packages/'));
    expect(engineChunks.length).toBeGreaterThan(0);
    for (const chunk of engineChunks) expect(initial.has(chunk.file), chunk.file).toBe(false);
    const threeChunk = Object.values(manifest).find((chunk) => chunk.src?.includes('three-backend'));
    expect(threeChunk && initial.has(threeChunk.file)).toBe(false);
    // A static import would inline engine code into the entry chunk instead.
    for (const file of initial) expect(readFileSync(new URL(file, DIST), 'utf8'), file).not.toMatch(ENGINE_CODE);

    const scripts: string[] = [];
    const errors: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname.slice(1));
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${LAZY_HOST}?backend=${backend}`);
    await expect(page.getByRole('heading', { name: 'A host application' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    // Network log: only the host's own code so far.
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(initial.has(script), script).toBe(true);
    expect(await page.evaluate(() => (window as { lazyHostGlobe?: unknown }).lazyHostGlobe === undefined)).toBe(true);

    await page.getByRole('button', { name: 'Show the map' }).click();
    await expect(page.locator('#map-status')).toHaveText(`Map ready (${backend})`, { timeout: 60_000 });
    expect(scripts.some((script) => threeChunk?.file === script)).toBe(true);
    // The view fills the canvas with imagery: no pixel of the white page shows through, none is left black. The
    // outermost pixels are skipped: an element screenshot rounds a fractional page offset into one row of the page.
    const image = await canvasImage(page, '#map canvas');
    let empty = 0;
    for (let y = 1; y < image.height - 1; y++) {
      for (let x = 1; x < image.width - 1; x++) {
        const i = (y * image.width + x) * 4;
        const [r, g, b] = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
        if ((r === 255 && g === 255 && b === 255) || r + g + b < 15) empty++;
      }
    }
    expect(empty).toBe(0);
    expect(errors).toEqual([]);
  });
}
