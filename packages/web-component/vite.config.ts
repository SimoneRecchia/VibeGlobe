import { defaultClientConditions, defineConfig } from 'vite';

// The browser build (F481): one ES module with the engine bundled in, plus the worker program next to it, for pages
// that load the element with a `<script type="module">` and no bundler. The package's `tsc -b` build stays the
// entry point for bundlers.
export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: {
    outDir: 'dist/browser',
    emptyOutDir: true,
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'vibe-globe.js' },
    worker: { format: 'es' },
  },
  worker: { format: 'es' },
});
