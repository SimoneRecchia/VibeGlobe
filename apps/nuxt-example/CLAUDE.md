# Nuxt example

Minimal Nuxt app with server-side rendering that uses `@vibeglobe/vue` as a consumer would, from the packages' `dist`
(M14: F486, F487). Sources in `src/` (`srcDir`): a home page without a globe and `/globe` with the globe component;
the base imagery is the playground's (`nuxt.config.ts`, `nitro.publicAssets`).

## Rules

- Server-rendered pages must not create an engine: the component renders its placeholder on the server.
- The globe page exposes test hooks on `window.adapterExample` (e2e/nuxt-example.spec.ts).

## Commands

- `npm run build -w @vibeglobe/nuxt-example` (after `npm run build` at the root) builds `.output/`;
  `npm run start -w @vibeglobe/nuxt-example` serves it (port from `PORT`, 5181 in the end-to-end tests).
