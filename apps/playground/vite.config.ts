import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript sources, so the playground needs no prior package build.
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    port: Number(process.env['PLAYGROUND_PORT'] ?? 5173),
    strictPort: true,
  },
});
