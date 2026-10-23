import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';
import { FixtureServer } from '../../scripts/fixtures/tiles/server.ts';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
};

/** Serves a folder's files as they are under a URL prefix: what a plain static server does. */
function staticFolder(prefix: string, folder: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (!path.startsWith(prefix)) return next();
    const file = normalize(join(folder, path.slice(prefix.length)));
    if (!file.startsWith(folder) || !existsSync(file) || !statSync(file).isFile()) return next();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };
}

/**
 * The base imagery (the playground's), the Web Component's browser build under `/wc/` (F481) and the fixture tile
 * server (M3 plan §4.1), in dev and preview.
 */
function assets(): Plugin {
  const fixtures = new FixtureServer();
  const use = (server: { middlewares: { use: (handler: ReturnType<typeof staticFolder>) => void } }): void => {
    server.middlewares.use(fixtures.middleware);
    server.middlewares.use(
      staticFolder('/imagery/', new URL('../playground/public/imagery/', import.meta.url).pathname),
    );
    server.middlewares.use(
      staticFolder('/wc/', new URL('../../packages/web-component/dist/browser/', import.meta.url).pathname),
    );
  };
  return { name: 'adapter-example-assets', configureServer: use, configurePreviewServer: use };
}

export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript sources, as in the playground.
    conditions: ['source', ...defaultClientConditions],
  },
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'vibe-globe' } } }), assets()],
  build: {
    rollupOptions: { input: ['index.html', 'live.html', 'react.html', 'vue-element.html'] },
  },
  server: { port: Number(process.env['ADAPTER_EXAMPLES_PORT'] ?? 5180), strictPort: true },
});
