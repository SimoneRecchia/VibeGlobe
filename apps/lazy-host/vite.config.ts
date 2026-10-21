import { defineConfig } from 'vite';

export default defineConfig({
  // Built from the packages' dist, as a consumer's application would be; the base imagery is the playground's.
  publicDir: '../playground/public',
  // The end-to-end test reads which chunks the entry loads statically.
  build: { manifest: true },
  preview: { port: Number(process.env['LAZY_HOST_PORT'] ?? 5175), strictPort: true },
});
