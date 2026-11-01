# VibeGlobe

A TypeScript web engine that draws an interactive 3D globe and 2D map: a globe when zoomed out, a flat map at mid
zoom, an oblique 3D view up close. WebGPU with an automatic WebGL2 fallback, built to run smoothly on weak hardware.
Imagery, terrain, vector tiles, glTF models, application data, offline packages and ready-made controls, as ESM
packages under `@vibeglobe/*`. Framework-agnostic, with Vue 3 and Web Component adapters.

**For AI agents:** [llms.txt](llms.txt) is the index of the guides by task. Installed, the index and the guides
matching the version are in `node_modules/@vibeglobe/core/` (`llms.txt`, `docs/guides/`).

![The playground's showcase: the globe over the space background with every control and the settings panel open](docs/images/playground-showcase.png)

## The smallest globe

```ts
import { createControls } from '@vibeglobe/controls';
import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

const controls = createControls();
const globe = createGlobe({
  container: document.getElementById('map') as HTMLElement,
  renderer: createRenderer(),
  controls,
  baseImageryUrl: '/static/vibeglobe/fallback-base.jpg',
  workers: createWorkers({ url: '/static/vibeglobe/vibeglobe-worker.js' }),
  imagery: [
    xyzImagery({
      id: 'imagery',
      url: 'https://tiles.example.com/imagery/{z}/{x}/{y}.jpg',
      maxLevel: 14,
      attribution: [{ text: 'Imagery © Example', url: 'https://example.com/terms' }],
    }),
  ],
  view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 },
});
await globe.ready;
```

The [integration guide](docs/guides/integration.md) explains each line, the assets to host, Vue, Nuxt and the Web
Component. For ready map types of Europe and the world from free sources, use the
[Europe preset](docs/guides/europe-preset.md) instead of listing sources by hand.

## Packages

| Package                    | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `@vibeglobe/core`          | `createGlobe`, camera, tiling, scheduling, cache, events, geodesy                    |
| `@vibeglobe/renderer`      | The WebGPU and WebGL2 backends; glTF, vector tile and starfield renderers by subpath |
| `@vibeglobe/worker`        | The worker pool that decodes tiles and models off the main thread                    |
| `@vibeglobe/sources`       | Imagery, terrain, vector and 3D source adapters, provider profiles                   |
| `@vibeglobe/controls`      | Mouse, touch, trackpad and keyboard navigation                                       |
| `@vibeglobe/layers`        | Application data: markers, labels, lines, polygons, models, vector tile styles       |
| `@vibeglobe/models`        | glTF 2.0 and GLB parsing and validation, Draco and meshopt decoding                  |
| `@vibeglobe/offline`       | Network modes, the browser tile cache, offline packages                              |
| `@vibeglobe/presets`       | `europeOpen`: ready map types from free, redistributable sources                     |
| `@vibeglobe/ui`            | Optional ready-made controls, themes and translations                                |
| `@vibeglobe/gis`           | Coordinates, reference systems, measurement, view state, panel detection             |
| `@vibeglobe/quality`       | Quality presets and the adaptive frame-time governor                                 |
| `@vibeglobe/vue`           | Vue 3 components and composables, SSR-safe                                           |
| `@vibeglobe/web-component` | The `<vibe-globe>` custom element                                                    |
| `@vibeglobe/tools`         | Command-line data pipeline and offline package builder                               |

Each package's README lists its entry points and pitfalls.

## Install

Node.js 22.18 or later for the tools. The packages are not on the npm registry yet: build the tarballs from a tag
(`npm ci && npm run build && npm run release:pack`) and install them from files. Once published, they install as
`npm install @vibeglobe/core @vibeglobe/renderer …`.

## Licensing

VibeGlobe is open source under the [Mozilla Public License 2.0](LICENSE.md) (SPDX `MPL-2.0`), copyright Simone
Recchia. There is no separate commercial license.

- **Any use, commercial included:** you may use, change and distribute VibeGlobe, alone or inside larger works under
  other licenses, at no cost.
- **Changes to VibeGlobe's own files stay open:** if you distribute a modified VibeGlobe file, its source is available
  under the MPL 2.0, and its license notice is kept. Your own files that only use VibeGlobe may stay under any
  license.

Third-party components keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Map data
is not part of VibeGlobe: it is licensed by its providers, and the application that shows it chooses its sources,
holds their keys and keeps to their terms ([provider profiles](docs/guides/sources.md#provider-profiles)). The default
datasets and their attribution rules are in [data licenses](docs/data-licenses.md).

## Working on VibeGlobe

```sh
./init.sh          # install, build, start the playground, run the tests
npm run dev        # the playground at http://localhost:5173: every control, settings and demo data
npm run status     # feature-list progress
```

- [CLAUDE.md](CLAUDE.md): how the library is developed, its rules and commands.
- [PLAN.md](PLAN.md): the owner's brief; [docs/internal/](docs/internal/plan/README.md): plans, architecture
  decisions, research, bug and test logs.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute, with the [Developer Certificate of Origin](DCO.md) sign-off.
- [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): reports go to recchia.sim@gmail.com.
