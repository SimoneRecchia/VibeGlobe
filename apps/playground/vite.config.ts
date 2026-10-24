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

// In CI's containers localhost may resolve to ::1 while Vite listens on 127.0.0.1: listen on both (ADR 0035).
const HOST = process.env['CI'] ? { host: '::' } : {};

export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript sources, so the playground needs no prior package build.
    conditions: ['source', ...defaultClientConditions],
  },
  plugins: [fixtureTiles()],
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
