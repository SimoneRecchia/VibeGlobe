// The minimal Nuxt example (M14): server-side rendering on, the globe page renders the Vue adapter's placeholder on
// the server and starts the engine after hydration.
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  srcDir: 'src',
  ssr: true,
  devtools: { enabled: false },
  telemetry: false,
  // The base imagery is the playground's, served as a static asset of the app.
  nitro: { publicAssets: [{ dir: '../../playground/public/imagery', baseURL: '/imagery', maxAge: 3600 }] },
  // three.js makes one chunk of about 1.1 MB; the default 500 kB limit would print a warning on every build.
  vite: { build: { chunkSizeWarningLimit: 2000 } },
  app: { head: { title: 'VibeGlobe Nuxt example' } },
});
