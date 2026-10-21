# VibeGlobe

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
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute, with the [contributor license agreement](CLA.md).
- [SECURITY.md](SECURITY.md): how to report a vulnerability.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): community standards.

## Packages

The packages will be published on the public npm registry under the [`@vibeglobe`](https://www.npmjs.com/org/vibeglobe) organization, for example `@vibeglobe/core` and `@vibeglobe/vue`. Nothing is published before the first release.

## Licensing

VibeGlobe is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md) (SPDX `PolyForm-Noncommercial-1.0.0`).

- **Noncommercial use is free:** you may use, change and share VibeGlobe at no cost for any noncommercial purpose, as the license defines it (personal projects, research, study, and use by charitable, educational, public research and government organizations).
- **Commercial use needs a commercial license:** any commercial use, including selling or reselling VibeGlobe or products and services built on it, requires a separate commercial license from the owner, Simone Recchia.
- **Requesting a commercial license:** open an issue with the "Commercial license inquiry" template (it asks only for your organization, the intended use and how to reach you; keep confidential details for the private follow-up), or contact [@SimoneRecchia](https://github.com/SimoneRecchia) directly. The owner answers privately.

Third-party components keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Map data shown by the engine is licensed by its providers; the default datasets and their attribution rules are documented with the data pipeline.

External contributions are accepted under the [contributor license agreement](CLA.md), so that they can be offered under both the noncommercial and the commercial licenses.
