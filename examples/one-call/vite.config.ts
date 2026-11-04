import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs, so the WebAssembly the worker program loads stays next to it when the engine assets are served
  // from another path (F531): with the default '/' the bundler writes it as '/assets/…' into the worker.
  base: './',
  build: { manifest: true },
});
