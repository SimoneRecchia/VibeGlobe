# Lazy host

Fixture host application for F547: a page that renders on its own and loads the engine with a dynamic import only after the user asks for the map. It is built from the packages' `dist`, as a consumer's application would be.

## Rules

- No static import of an engine package or three.js anywhere in `src`: `e2e/lazy-host.spec.ts` checks the build manifest, the entry chunk's content and the network log before the button is clicked.
- `?backend=webgpu|webgl2` forces a backend; the base imagery is the playground's (`vite.config.ts`, `publicDir`).

## Commands

- `npm run build` (root) builds it after the packages; `npm run test:e2e` serves the build on :5175 (`LAZY_HOST_PORT` to change) with `vite preview`.
