import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';
import { FixtureServer } from '../../scripts/fixtures/tiles/server.ts';

/** Serves the deterministic fixture tiles and their fault rules same-origin (M3 plan §4.1), in dev and preview. */
function fixtureTiles(): Plugin {
  const fixtures = new FixtureServer();
  return {
    name: 'vibeglobe-fixture-tiles',
    configureServer: (server) => void server.middlewares.use(fixtures.middleware),
    configurePreviewServer: (server) => void server.middlewares.use(fixtures.middleware),
  };
}

// The dataset pipeline's local outputs for the playground's `?scenario=mont-blanc` (dev and preview only; consumers
// host their own tiles, ADR 0015). GET /real-data/{build}/{dataset}/index.json answers `{ metadata, tiles: ["z/x/y", …] }`
// from packages/tools/node_modules/.vibeglobe-data/{build}/output/{dataset}/, or `{ missing: true }` (status 200, so the
// page logs no failed request) when that build has not been run; GET /real-data/{build}/{dataset}/{z}/{x}/{y}.{png,jpg}
// serves a tile.

/** Where `vibeglobe-data build` writes its outputs. */
const DATA_ROOT = join(import.meta.dirname, '../../packages/tools/node_modules/.vibeglobe-data');
const INDEX = /^\/real-data\/([a-z0-9-]+)\/([a-z0-9-]+)\/index\.json$/;
const TILE = /^\/real-data\/([a-z0-9-]+)\/([a-z0-9-]+)\/(\d+)\/(\d+)\/(\d+)\.(png|jpg)$/;
const TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg' };

/** The `z/x/y` keys of every tile in a dataset folder. */
function tileKeys(folder: string): string[] {
  const keys: string[] = [];
  const numeric = (names: string[]): string[] => names.filter((name) => /^\d+$/.test(name));
  for (const z of numeric(readdirSync(folder)))
    for (const x of numeric(readdirSync(join(folder, z))))
      for (const file of readdirSync(join(folder, z, x))) keys.push(`${z}/${x}/${file.replace(/\..*$/, '')}`);
  return keys;
}

/** Answers the `/real-data/` requests; passes every other request on. */
function realDataMiddleware(request: IncomingMessage, response: ServerResponse, next: () => void): void {
  const path = (request.url ?? '').split('?')[0] ?? '';
  const index = INDEX.exec(path);
  if (index) {
    const folder = join(DATA_ROOT, index[1] ?? '', 'output', index[2] ?? '');
    const metadataFile = join(folder, 'metadata.json');
    const body = existsSync(metadataFile)
      ? { metadata: JSON.parse(readFileSync(metadataFile, 'utf8')) as unknown, tiles: tileKeys(folder) }
      : { missing: true };
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(body));
    return;
  }
  const tile = TILE.exec(path);
  if (!tile) return next();
  const [, build = '', dataset = '', z = '', x = '', y = '', extension = ''] = tile;
  const file = join(DATA_ROOT, build, 'output', dataset, z, x, `${y}.${extension}`);
  if (!existsSync(file)) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('Content-Type', TYPES[extension] ?? 'application/octet-stream');
  response.end(readFileSync(file));
}

/** Serves the dataset pipeline's local outputs for `?scenario=mont-blanc` (`realDataMiddleware`), in dev and preview. */
function realData(): Plugin {
  return {
    name: 'vibeglobe-real-data',
    configureServer: (server) => void server.middlewares.use(realDataMiddleware),
    configurePreviewServer: (server) => void server.middlewares.use(realDataMiddleware),
  };
}

// In CI's containers localhost may resolve to ::1 while Vite listens on 127.0.0.1: listen on both (ADR 0035).
const HOST = process.env['CI'] ? { host: '::' } : {};

export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript sources, so the playground needs no prior package build.
    conditions: ['source', ...defaultClientConditions],
  },
  plugins: [fixtureTiles(), realData()],
  // Pre-bundled at start-up, with the test harness pages scanned too: a dependency the dev server discovers only when
  // a page imports it (sql.js and draco3d load lazily) makes it reload that page, in the middle of a test.
  optimizeDeps: {
    entries: ['index.html', '../../e2e/support/*.html'],
    include: [
      '@maplibre/maplibre-gl-style-spec',
      '@noble/hashes/sha2.js',
      '@noble/hashes/utils.js',
      'draco3d',
      'earcut',
      'fflate',
      'pbf',
      'pmtiles',
      'proj4',
      'rbush',
      'sql.js',
      'supercluster',
      'txml',
    ],
  },
  server: {
    port: Number(process.env['PLAYGROUND_PORT'] ?? 5173),
    strictPort: true,
    ...HOST,
  },
  // The production build, for tests of what consumers ship (F100's strict Content Security Policy).
  preview: {
    port: Number(process.env['PLAYGROUND_PREVIEW_PORT'] ?? 5176),
    strictPort: true,
    ...HOST,
  },
});
