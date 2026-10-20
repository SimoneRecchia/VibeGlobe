# VibeGlobeEngine

A generic, modular web engine that renders an interactive 3D globe and map — globe when zoomed out, flat 2D map at mid zoom, oblique 3D view up close — built for fluidity and zero visual glitches. TypeScript, WebGPU with automatic WebGL2 fallback, framework-agnostic core with Vue 3 and Web Component adapters.

Status: early development. See `npm run status` for progress against the feature list.

## Quick start

Requires Node.js 22.18 or later.

```sh
./init.sh          # install, build, start the playground, run the tests
npm run dev        # playground at http://localhost:5173
npm run status     # feature-list progress
```

## Documentation

- [PLAN.md](PLAN.md): the owner's master brief.
- [docs/plan/](docs/plan/README.md): technical plan (architecture, APIs, milestones, targets and testing).
- [docs/adr/](docs/adr/README.md): architecture decisions.
- [docs/research/](docs/research/README.md): research survey.
- [progress.md](progress.md): session log.
