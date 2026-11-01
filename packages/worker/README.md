# @vibeglobe/worker

The worker program of the engine's worker pool and `createWorkers`, the factory that starts it. The program decodes
imagery, terrain and KTX2 tiles and parses vector formats off the main thread; the full program also runs data-layer
clustering, vector tiles and glTF models. Workers are module workers loaded from the page's origin, with no
`blob:` workers and no generated code, so the engine runs under a strict Content Security Policy. Every globe with
imagery or terrain needs it (`GlobeOptions.workers`).

## Install

Needs `@vibeglobe/core` and `@vibeglobe/sources` (dependencies). The main entry's program also needs the optional peer
dependencies `@vibeglobe/layers` and `@vibeglobe/models`; `@vibeglobe/worker/basic` needs neither.

## Entry points

| Import path                                   | What                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `@vibeglobe/worker`                           | `createWorkers` with every task; `WorkerConfigError`                     |
| `@vibeglobe/worker/basic`                     | `createWorkers` with imagery, terrain, KTX2 and vector-parser tasks only |
| `@vibeglobe/worker/transcode-ktx2`            | `createTranscodeKtx2`, for tests and tools with their own transcoder     |
| `@vibeglobe/worker/vibeglobe-worker.js`       | The full worker program                                                  |
| `@vibeglobe/worker/vibeglobe-worker-basic.js` | The basic worker program                                                 |

## Example

```ts
import { createGlobe } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker/basic';

createGlobe({
  container,
  renderer,
  baseImageryUrl: '/static/vibeglobe/fallback-base.jpg',
  workers: createWorkers({ count: 2 }), // default: hardwareConcurrency − 2, from 1 to 4
  imagery: [xyzImagery({ id: 'base', url: 'https://tiles.example.com/{z}/{x}/{y}.png' })],
});
```

## Pitfalls

- `createWorkers({ url })` throws a `WorkerConfigError` for a cross-origin, `blob:` or `data:` URL or an invalid count.
- Without `url` the bundler (Vite, webpack 5, Parcel) emits the program; the files in `dist/` import other packages by
  name and cannot be served as they are.
- The program loads its WebAssembly from its own directory: with Vite, build with `base: './'` to serve the emitted
  assets under another path.
- Nothing starts until the engine asks for a worker, so `createWorkers` costs nothing until then.

## Guides

[Hosting](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/hosting.md),
[Integration](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/integration.md).
