---
title: 3D models
---

# 3D models

glTF 2.0 models stand on the globe as features of two layers from `@vibeglobe/layers/models`: `ModelLayer` for a few
models, each with its own file and pose, and `ModelSetLayer` for many copies of one model, drawn instanced. Both need
the renderer's glTF loader: `createRenderer({ gltf: gltfLoader })` with `gltfLoader` from `@vibeglobe/renderer/gltf`
(in Vue, the `gltf` prop of `VibeGlobe`). `globe.addModel` places one model without a layer stack, and OGC 3D Tiles
stream through `tiles3d` (see [3D Tiles](#3d-tiles)). Points, lines and other data are in the
[data layers guide](data-layers.md).

## Quick start

```ts
import { createGlobe } from '@vibeglobe/core';
import { createGlobeLayers } from '@vibeglobe/layers';
import { ModelLayer } from '@vibeglobe/layers/models';
import { createRenderer } from '@vibeglobe/renderer';
import { gltfLoader } from '@vibeglobe/renderer/gltf';

const globe = createGlobe({
  container,
  renderer: createRenderer({ gltf: gltfLoader }),
  baseImageryUrl: '/static/vibeglobe/fallback-base.jpg',
});
await globe.ready;
const { stack } = createGlobeLayers(globe, { element: container });
const station = stack.add(
  new ModelLayer({
    models: [
      {
        id: 'substation',
        url: '/models/substation.glb',
        position: { longitudeDeg: 9.1, latitudeDeg: 45.3 },
        headingDeg: 90,
      },
    ],
    draggable: true,
  }),
);
station.on('error', ({ message }) => console.warn(message));
station.on('click', ({ feature }) => console.log(feature.id));
await station.ready;
```

The model stands at its position, facing east, and is picked, hovered, clicked, selected and dragged like any
data-layer feature. `gltfLoader` downloads three.js's `GLTFLoader` with the first model.

## Single models

A `ModelFeature` has an `id`, a `url` or its `data` (`.glb` bytes), a `position`, and optionally `headingDeg`
(clockwise from north), `pitchDeg` (nose up), `rollDeg` (right side down), `scale` and `properties`. Models load when
the layer is added to a stack; `ready` settles once every model has loaded or failed, and a model that fails emits
`error` and is left out. A position's `heightMeters` (default 0) is above the WGS84 ellipsoid: over terrain, take
the ground's height from `globe.elevationAtAsync(position)`. `setFeaturePosition(id, lon, lat, heightMeters)` moves a model; `setFeatureState` with
`selected` or `hover` blends it toward `selectedHighlight` (default yellow, `[1, 1, 0, 0.6]`) or `hoverHighlight`
(default white, `[1, 1, 1, 0.25]`).

`globe.addModel({ url, position, headingDeg, scale })` adds one model without a layer: it resolves with a
`ModelHandle` (`setPose`, `remove`) and rejects with a `GlobeError` for invalid options or a file the loader cannot
read.

## Many copies of one model

A `ModelSetLayer` loads its file once. Each mesh of the model is one instanced draw for every copy in view nearer the
eye than `visibleBelowMeters` (default 3,000 m). Farther copies are one instanced draw of a placeholder of constant
size on screen. Copies outside the view, or behind the globe, are not drawn. Each copy is a feature: picked, hovered,
clicked and selected like the others, and moved with `setFeaturePosition`; copies cannot be dragged.

```ts
import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers } from '@vibeglobe/layers';
import { ModelSetLayer, type ModelSetItem } from '@vibeglobe/layers/models';

declare const globe: Globe;

// 2,000 turbines on a 50 × 40 grid 500 m apart, facing west.
const turbines: ModelSetItem[] = [];
for (let row = 0; row < 40; row++)
  for (let column = 0; column < 50; column++)
    turbines.push({
      id: `T${row}-${column}`,
      position: { longitudeDeg: 9 + column * 0.00635, latitudeDeg: 45.2 + row * 0.0045 },
      headingDeg: 270,
      properties: { farm: 'Example', row, column },
    });
const { stack } = createGlobeLayers(globe, { element: container });
const farm = stack.add(
  new ModelSetLayer({
    id: 'wind-farm',
    url: '/models/turbine.glb',
    models: turbines,
    visibleBelowMeters: 3000,
    placeholder: { color: [0.2, 0.45, 0.9], sizePx: 8 },
  }),
);
farm.on('click', ({ feature }) => console.log(feature.properties));
await farm.ready;
```

The renderer walks every copy once a frame to place and cull it, a few arithmetic operations each, so tens of
thousands of copies stay cheap. Split a much larger set into one layer per area, so that whole areas can be hidden.
Choose `visibleBelowMeters` by the model's size: a 120 m turbine is a few pixels tall at 3 km, where the placeholder
reads better; for 3 m solar panels, 500 to 1,000 m is enough.

## Moving parts

A model of a set can have parts that move on every copy: a node that spins about its own Z axis, such as a turbine's
rotor, and a node that turns about its own Y axis to face a direction, such as the nacelle on the tower. Name them in
the glTF file, the rotor inside the nacelle, and give their names to the layer:

```ts
import type { LayerStack } from '@vibeglobe/layers';
import { ModelSetLayer, type ModelSetItem } from '@vibeglobe/layers/models';

declare const stack: LayerStack;
declare const turbines: readonly ModelSetItem[];

const farm = stack.add(
  new ModelSetLayer({
    id: 'wind-farm',
    url: '/models/wind-turbine.glb',
    models: turbines.map((t) => ({ ...t, yawDeg: 270, spinRpm: 15 })),
    yaw: { node: 'nacelle', degPerSecond: 6 }, // turns into the wind, the shorter way round
    spin: { node: 'rotor', rampSeconds: 4 }, // speeds up and slows down over 4 s
  }),
);
farm.setSpinRpm(12); // every rotor; farm.setSpinRpm(0, 'T3-7') stops one
farm.setYawDeg(225); // every nacelle faces south-west
```

A positive speed turns a rotor clockwise seen from the front (the node's −Z). `yawDeg` is the direction the nacelle
faces, clockwise from north; the copy's `headingDeg` still turns the whole model. The moving meshes stay in the same
instanced draws. While a part moves, the layer asks for a frame each frame, but only while some copy is drawn as the
model: a farm out of view, or beyond `visibleBelowMeters`, lets the globe rest.

## Standing on the terrain

Without a ground, a copy's `heightMeters` is above the ellipsoid, so with terrain a copy at 0 is buried in the hills.
`ground: globe` stands every copy on the terrain as the globe draws it: `heightMeters` becomes the height above the
ground (default 0). The heights come from the terrain already in memory (`globe.elevationAt`), so they cost no
request, and are sampled again when finer terrain arrives and when the relief rises from flat. A ground that cannot be
read (display-only terrain) emits `error` once, and the copies stay where they were.

```ts
import type { Globe } from '@vibeglobe/core';
import type { LayerStack } from '@vibeglobe/layers';
import { ModelSetLayer, type ModelSetItem } from '@vibeglobe/layers/models';

declare const globe: Globe;
declare const stack: LayerStack;
declare const turbines: readonly ModelSetItem[];
declare const markers: ReadonlyMap<string, HTMLElement>;

const farm = stack.add(new ModelSetLayer({ url: '/models/turbine.glb', models: turbines, ground: globe }));
// A marker on top of each 84 m turbine, placed on every frame the camera moves.
globe.on('camera-change', ({ reliefFactor }) => {
  for (const [id, element] of markers) {
    const top = farm.markerPosition(id, 84, reliefFactor);
    const point = top && globe.geoToScreen(top);
    if (point) element.style.transform = `translate(${point.xPx}px, ${point.yPx}px)`;
  }
});
```

`markerPosition(id, aboveMeters, reliefFactor)` is the position to hand `geoToScreen` for a point `aboveMeters` over
a copy's foot as the frame draws it. The frame scales heights by its relief and the model not, so the height is the
foot's plus `aboveMeters` divided by the relief; on a flat relief (0) it is the foot. Pass the frame's `reliefFactor`
when it is at hand: without it, each call reads the camera. `getPosition` returns the position as set (with a ground,
its height above it).

A long table or row of modules on a slope buries one end when it stands on the ground at its center.
`footprint: { widthMeters, depthMeters }` is the rectangle a copy covers, its width across its heading and its depth
along it, scaled with the copy. Each copy then stands level at the highest ground under its four corners and its
center; give the model legs that reach below its base, so each meets the lower ground.

```ts
import type { Globe } from '@vibeglobe/core';
import type { LayerStack } from '@vibeglobe/layers';
import { ModelSetLayer, type ModelSetItem } from '@vibeglobe/layers/models';

declare const globe: Globe;
declare const stack: LayerStack;
declare const tables: readonly ModelSetItem[];

const field = stack.add(
  new ModelSetLayer({
    url: '/models/solar-table.glb',
    models: tables,
    ground: globe,
    footprint: { widthMeters: 13.9, depthMeters: 4.4 },
  }),
);
```

## Framing a model or a whole plant

`framePositions(ids)` gives the corners of copies' model boxes as the frame draws them, at each copy's scale: the
tower's foot, the rotor's tip and the reach of the blades round the tower, a nacelle turned any way included. `ids`
default to every copy; the list is empty until the model has loaded. `fitObjects` of `@vibeglobe/layers` flies to the
view that shows them all, the middle of their heights at the view's center:

```ts
import type { Globe } from '@vibeglobe/core';
import { fitObjects } from '@vibeglobe/layers';
import type { ModelSetLayer } from '@vibeglobe/layers/models';

declare const globe: Globe;
declare const farm: ModelSetLayer;
declare const field: ModelSetLayer;

// One turbine, whole and centered, from the view's own tilt.
await fitObjects(globe, farm.framePositions(['WTG 01']), { paddingPx: 40 });
// A plant: every device of several sets, from 45° so the far rows show as well as the near ones.
await fitObjects(globe, [...farm.framePositions(), ...field.framePositions()], { paddingPx: 40, tiltDeg: 45 });
// A panel over the left side: the view frames in the part left visible, centered there.
await fitObjects(globe, farm.framePositions(['WTG 01']), { paddingPx: { top: 48, right: 120, bottom: 48, left: 460 } });
```

A fit never brings the eye nearer than 100 m to what it frames. Framing a plant's own coordinates frames one point;
only the devices' boxes give its width, depth and height.

## A light model

Every triangle of a set is drawn once per copy in view, so the model's weight multiplies. Recommended limits for a
model of a set, with hundreds of copies on screen at once:

| Item        | Recommended                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Triangles   | 500 to 5,000 (a wind turbine reads well with about 1,000); above 20,000 only for a few copies  |
| Meshes      | 1 to 3, each one draw for all copies: merge parts that share a material                        |
| Materials   | One per mesh: base color and an optional base color texture; other maps are not drawn          |
| Textures    | At most 512 × 512 px, or a plain base color factor; PNG or JPEG                                |
| Compression | meshopt or Draco, with the loader's decoders set (below); quantized attributes need no decoder |
| File size   | Under 200 KB compressed                                                                        |
| Axes        | Metres, +Y up, −Z facing north at heading 0, the origin at the model's foot                    |

The renderer draws models unlit: the base color and texture, shaded by a fixed light from above the eye, blended
toward the highlight. A mesh with several materials draws with its first. `gltfpack` (meshoptimizer, MIT) simplifies,
merges and compresses a model in one step: `gltfpack -i turbine.glb -o turbine-light.glb -si 0.2 -cc` keeps 20% of the
triangles and compresses with meshopt.

## Compressed models

`gltfLoader` decodes neither meshopt (`EXT_meshopt_compression`) nor Draco (`KHR_draco_mesh_compression`). For
compressed models, give `createRenderer` a loader factory of your own that sets both decoders on three.js's
`GLTFLoader`. meshopt decodes with meshoptimizer's WebAssembly module, shipped in `@vibeglobe/worker` as
`wasm/meshopt-decoder.wasm`, compiled by `meshoptWasmDecoder` of `@vibeglobe/models`. Draco decodes with three.js's
`DRACOLoader` and its decoder files. The application hosts both; each loads with the first model that needs it.

```ts
import { meshoptWasmDecoder } from '@vibeglobe/models';
import { createRenderer, type GltfLoaderFactory } from '@vibeglobe/renderer';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const meshopt = meshoptWasmDecoder(() => WebAssembly.compileStreaming(fetch('/vibeglobe/meshopt-decoder.wasm')));
const compressedGltf: GltfLoaderFactory = async () => {
  const loader = new GLTFLoader();
  // GLTFLoader calls only `supported`, `ready` and `decodeGltfBuffer`, which the decoder has.
  loader.setMeshoptDecoder((await meshopt()) as Parameters<GLTFLoader['setMeshoptDecoder']>[0]);
  loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/vibeglobe/draco/'));
  return loader;
};
const modelRenderer = createRenderer({ gltf: compressedGltf });
```

## 3D Tiles

OGC 3D Tiles stream into a globe as a render extension: `tiles3d` of `@vibeglobe/sources/tiles3d` loads and traverses
the tileset, and `threeTileMeshes` of `@vibeglobe/renderer/tiles3d` turns its content into meshes. glTF content parses
in the globe's `workers` (`createWorkers` of `@vibeglobe/worker`).

```ts
import type { Globe } from '@vibeglobe/core';
import { threeTileMeshes } from '@vibeglobe/renderer/tiles3d';
import { tiles3d, type Tiles3DExtension } from '@vibeglobe/sources/tiles3d';

declare const globe: Globe;

await globe.ready;
const created: Tiles3DExtension[] = [];
const removeCity = globe.addRenderExtension(
  tiles3d(
    {
      url: 'https://tiles.example.com/city/tileset.json',
      meshes: threeTileMeshes,
      dracoWasmUrl: 'https://app.example.com/vibeglobe/draco_decoder.wasm',
    },
    (extension) => created.push(extension),
  ),
);
const [city] = created;
await city?.loaded;
console.log(city?.pick(200, 150)?.properties);
```

The extension gives `loaded` (the parsed tileset), `pick(xPx, yPx)` (the feature under a canvas point, with its batch
or property table values), `copyrights()` (the drawn content's `asset.copyright`) and `stats()`. `tiles3d` options
include `maximumScreenSpaceError` (default 16 px), `memoryBudgetBytes` (default 256 MiB), `maxLoading` (default 32),
`transport`, `profile` and `onTileError`. The function `addRenderExtension` returns removes the tileset. Provider
tilesets with keys and credits are in the [sources guide](sources.md).

## Options

`ModelSetLayerOptions`:

| Option                                | Type                           | Default                     | Effect                                      |
| ------------------------------------- | ------------------------------ | --------------------------- | ------------------------------------------- |
| `url` or `data`                       | `string` or `ArrayBuffer`      | none                        | The glTF file every copy shows: exactly one |
| `models`                              | `ModelSetItem[]`               | required                    | The copies                                  |
| `visibleBelowMeters`                  | `number`                       | 3,000                       | Nearer copies draw the model                |
| `placeholder`                         | `{ color, sizePx }`            | `[0.95, 0.95, 0.97]`, 10 px | Far copies' mark; `sizePx: 0` for none      |
| `selectedHighlight`, `hoverHighlight` | `[r, g, b, amount]` in 0–1     | yellow 0.6, white 0.25      | Blend of selected and hovered copies        |
| `ground`                              | `ModelSetGround` (a `Globe`)   | none                        | Stands copies on the terrain                |
| `footprint`                           | `{ widthMeters, depthMeters }` | none                        | With `ground`: stand level on the highest   |
| `spin`                                | `{ node, rpm, rampSeconds }`   | `rpm` 0, `rampSeconds` 4    | A part spinning about its Z axis            |
| `yaw`                                 | `{ node, degPerSecond }`       | `degPerSecond` 6            | A part turning about its Y axis             |

A `ModelSetItem` has `id`, `position`, `headingDeg`, `pitchDeg`, `rollDeg`, `scale`, `spinRpm` (instead of
`spin.rpm`), `yawDeg` (default: its heading) and `properties`.

## Rules and pitfalls

- A renderer without `gltf` draws no models: every model fails to load with an `error` event.
- `ModelSetLayer` and `globe.addModel` take exactly one of `url` and `data`.
- Model ids are unique within a layer.
- `framePositions` is empty until `ready` has settled, and `fitObjects` of an empty list throws a `RangeError`.
- `spin.node` and `yaw.node` must match node names in the glTF file exactly; a name that is not found does not move.
- The yawing node holds the spinning one: the rotor inside the nacelle.
- Removing a model layer from its stack frees its models and drops its event handlers.
- 3D Tiles content needs the `parse-model` task: the globe's `workers` from `@vibeglobe/worker` have it,
  `@vibeglobe/worker/basic` has not. Without it, `modelTasks: createModelTasks()` of `@vibeglobe/models` parses on the
  main thread; otherwise such tiles fail through `onTileError`.
- Draco content of 3D Tiles needs `dracoWasmUrl`, the absolute URL of `draco_decoder.wasm` that the application hosts.
- three.js's `DRACOLoader` starts its workers from Blob URLs, which a Content Security Policy must allow
  (`worker-src blob:`); meshopt needs no worker.

## Errors

| Error or code                   | When                                                                         | What to do                               |
| ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| `error` event                   | A model fails to load, the target draws no models, or a ground is unreadable | Check the renderer's `gltf` and the file |
| `RangeError`                    | A duplicate id, both or neither of `url` and `data`, an invalid number       | Fix the options                          |
| `GlobeError` `'invalid-option'` | `globe.addModel` with invalid options, before `ready`, or an unreadable file | Check `cause` for the loader's error     |
| `GlobeError` `'invalid-option'` | `addRenderExtension` before `globe.ready`                                    | Await `globe.ready` first                |

## See also

- [Data layers](data-layers.md): the layer stack, events, selection and `fitObjects`.
- [Sources](sources.md): Photorealistic 3D Tiles with a provider's transport and profile.
- [Terrain](terrain.md): the terrain models stand on and `elevationAt`.
