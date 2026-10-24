// A Nuxt consumer with no engine asset configuration: the bundler emits the worker program and its WebAssembly (F531).
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  ssr: true,
  devtools: { enabled: false },
  telemetry: false,
  app: { head: { title: 'VibeGlobe Nuxt consumer', link: [{ rel: 'icon', href: 'data:,' }] } },
});
