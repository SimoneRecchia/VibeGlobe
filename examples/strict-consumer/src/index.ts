// A strict TypeScript consumer of every published entry point, type-checked against the packed tarballs (F530).
import { WGS84, createGlobe, type Ellipsoid, type Globe, type GlobeOptions } from '@vibeglobe/core';
import * as decoders from '@vibeglobe/core/decoders';
import * as geodesy from '@vibeglobe/core/geodesy';
import * as controls from '@vibeglobe/controls';
import * as gis from '@vibeglobe/gis';
import * as layers from '@vibeglobe/layers';
import * as layersTesting from '@vibeglobe/layers/testing';
import * as layerModels from '@vibeglobe/layers/models';
import * as layerVectorTiles from '@vibeglobe/layers/vector-tiles';
import * as clusterWorker from '@vibeglobe/layers/cluster-worker';
import * as models from '@vibeglobe/models';
import * as offline from '@vibeglobe/offline';
import * as quality from '@vibeglobe/quality';
import { createRenderer } from '@vibeglobe/renderer';
import * as rendererGltf from '@vibeglobe/renderer/gltf';
import * as rendererVectorTiles from '@vibeglobe/renderer/vector-tiles';
import * as rendererTiles3d from '@vibeglobe/renderer/tiles3d';
import { xyzImagery } from '@vibeglobe/sources';
import * as conformance from '@vibeglobe/sources/conformance';
import * as vector from '@vibeglobe/sources/vector';
import * as mbtiles from '@vibeglobe/sources/mbtiles';
import * as sourceTiles3d from '@vibeglobe/sources/tiles3d';
import * as geotiff from '@vibeglobe/sources/geotiff';
import * as tools from '@vibeglobe/tools';
import * as ui from '@vibeglobe/ui';
import * as vue from '@vibeglobe/vue';
import * as webComponent from '@vibeglobe/web-component';
import { createWorkers } from '@vibeglobe/worker';
import * as basicWorkers from '@vibeglobe/worker/basic';

const ellipsoid: Ellipsoid = WGS84;

/** A globe with one tiled imagery source, written against the published types only. */
export function start(container: HTMLElement): Globe {
  const options: GlobeOptions = {
    container,
    renderer: createRenderer(),
    controls: controls.createControls(),
    baseImageryUrl: '/fallback-base.jpg',
    workers: createWorkers(),
    imagery: [xyzImagery({ id: 'imagery', url: 'https://tiles.example.com/{z}/{x}/{y}.jpg', maxLevel: 14 })],
  };
  return createGlobe(options);
}

export const entryPoints = {
  ellipsoid,
  decoders,
  geodesy,
  gis,
  layers,
  layersTesting,
  layerModels,
  layerVectorTiles,
  clusterWorker,
  models,
  offline,
  quality,
  rendererGltf,
  rendererVectorTiles,
  rendererTiles3d,
  conformance,
  vector,
  mbtiles,
  sourceTiles3d,
  geotiff,
  tools,
  ui,
  vue,
  webComponent,
  basicWorkers,
};
