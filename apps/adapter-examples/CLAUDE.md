# Adapter examples

Example pages for the framework adapters (M14), served by Vite on :5180 (`ADAPTER_EXAMPLES_PORT`):

- `index.html`: the minimal Vite + Vue 3 example of `@vibeglobe/vue` (F473–F480); `?two=1` shows two globes (F479).
- `react.html` and `vue-element.html`: a React and a Vue app that use the `<vibe-globe>` element (F483).
- `public/plain.html`: a plain HTML page with no framework and no bundler that loads the element's browser build from
  `/wc/` (F481, F482, F484). `npm run build` (root) builds it into `packages/web-component/dist/browser/` first.

## Rules

- The only app besides the Nuxt example allowed to use Vue, and the only one allowed to use React (`npm run check`).
- Pages expose test hooks on `window.adapterExample` (`src/hooks.ts`); the end-to-end specs are `e2e/vue-*.spec.ts`
  and `e2e/web-component-*.spec.ts`.

## Commands

- `npm run dev -w @vibeglobe/adapter-examples` serves the pages; `npm run typecheck -w @vibeglobe/adapter-examples`
  runs vue-tsc in strict mode (part of `npm run build`).
