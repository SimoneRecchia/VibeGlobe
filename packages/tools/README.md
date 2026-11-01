# @vibeglobe/tools

The `vibeglobe-data` command line, also usable as a Node library: the data pipeline that builds tile folders, PMTiles
and MBTiles packages from open datasets (imagery, terrain, vector tiles, the global base image), and the offline
package builder that packs an area of a tile source. Every output records its sources' licence and attribution, and a
license gate refuses sources whose terms forbid packaging. An application needs it to build the data it hosts, such as
the Europe preset's package; the browser never loads it.

## Install

Node.js 22.18 or later. Depends on `@vibeglobe/core` and `pmtiles`; no peer dependencies. Docker runs GDAL for datasets
with a `convert` step and for `verify`.

## Entry points

| Import path        | What                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `vibeglobe-data`   | The command: `estimate`, `build` and its steps, `verify`, `pack`, `licenses`, `help`                  |
| `@vibeglobe/tools` | `main`, `loadConfig`, `estimateBuild`, `runBuild`, `formatEstimate`, `PROVIDER_PROFILES`              |
| `configs/`         | The shipped configurations, named by file: `europe.json`, `world-satellite.json`, `world-low.json`, … |

## Example

```sh
npx vibeglobe-data estimate europe.json --measure
npx vibeglobe-data build europe.json --yes --out ./europe-package \
  --source-url europe-vectors=https://btrfs.openfreemap.com/areas/planet/20261020_001001_pt/tiles.pmtiles
```

```ts
import { estimateBuild, formatEstimate, loadConfig } from '@vibeglobe/tools';

const loaded = loadConfig('node_modules/@vibeglobe/tools/configs/europe.json');
console.log(formatEstimate(estimateBuild(loaded, { sample: false })));
```

## Pitfalls

- `build` prints the estimate and asks before downloading; a run without a terminal needs `--yes`.
- Outputs go to `node_modules/.vibeglobe-data/<config>` inside the package by default: pass `--out` to keep them.
- A configuration whose archive URL holds `<version>` (OpenFreeMap's) needs `--source-url <dataset>=<url>`.
- `--sample` builds only the configuration's sample area, to check a configuration cheaply.

## Guides

- [The Europe preset](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/europe-preset.md): building and estimating its package
- [Hosting](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/hosting.md): serving the outputs
- [Offline](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/offline.md): `pack` and package manifests
- [Data licenses](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/data-licenses.md): the datasets and their credits
