// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The tour's chapters and scenes. Each scene's module loads only when the scene opens; every scene works without the
 * network except those marked `online`, which wait for the visitor's consent.
 */
import type { ChapterId, SceneEntry } from './types.js';

/** The chapters, in the order of the rail. */
export const CHAPTERS: readonly (readonly [id: ChapterId, title: string])[] = [
  ['earth', 'Earth'],
  ['views', 'Views'],
  ['imagery', 'Imagery'],
  ['terrain', 'Terrain'],
  ['vector', 'Vector'],
  ['data', 'Data'],
  ['models', 'Models'],
  ['tools', 'Tools'],
  ['offline', 'Offline'],
  ['performance', 'Speed'],
  ['integrations', 'Apps'],
];

/** The scene of a page without `#scene=`. */
export const DEFAULT_SCENE = 'globe';

const earth = (): Promise<typeof import('./scenes/earth.js')> => import('./scenes/earth.js');
const views = (): Promise<typeof import('./scenes/views.js')> => import('./scenes/views.js');
const imagery = (): Promise<typeof import('./scenes/imagery.js')> => import('./scenes/imagery.js');
const terrain = (): Promise<typeof import('./scenes/terrain.js')> => import('./scenes/terrain.js');
const vector = (): Promise<typeof import('./scenes/vector.js')> => import('./scenes/vector.js');
const points = (): Promise<typeof import('./scenes/data-points.js')> => import('./scenes/data-points.js');
const shapes = (): Promise<typeof import('./scenes/data-shapes.js')> => import('./scenes/data-shapes.js');
const models = (): Promise<typeof import('./scenes/models.js')> => import('./scenes/models.js');
const tools = (): Promise<typeof import('./scenes/tools.js')> => import('./scenes/tools.js');
const speed = (): Promise<typeof import('./scenes/performance.js')> => import('./scenes/performance.js');

/** Every scene, chapter by chapter. */
export const SCENES: readonly SceneEntry[] = [
  {
    id: 'globe',
    chapter: 'earth',
    title: 'The globe',
    summary:
      'One engine for the globe and the flat map, on WebGPU with a WebGL2 fallback. Clustered markers, a polygon, a ' +
      'route and labels sit on the bundled Natural Earth image: click a cluster to zoom into it.',
    guide: 'integration.md',
    load: async () => (await earth()).globeScene,
  },
  {
    id: 'sky',
    chapter: 'earth',
    title: 'Space and atmosphere',
    summary:
      'Stars and the Milky Way behind the globe, a scattering atmosphere around it, and haze and fog over the ground.',
    guide: 'space-background.md',
    load: async () => (await earth()).sky,
  },
  {
    id: 'sun',
    chapter: 'earth',
    title: 'Sun, day and night',
    summary: 'Light the globe by the Sun at any date and time, and show the night side the way map applications do.',
    guide: 'space-background.md#day-and-night-and-a-clearer-globe-from-afar',
    load: async () => (await earth()).sun,
  },
  {
    id: 'poles',
    chapter: 'earth',
    title: 'Polar caps',
    summary: 'Web Mercator ends at 85° of latitude; the caps beyond take the colors of the map drawn below them.',
    guide: 'sources.md#polar-caps',
    load: async () => (await earth()).poles,
  },
  {
    id: 'view-modes',
    chapter: 'views',
    title: '2D, 3D and Auto',
    summary:
      'The globe flattens into a map as you zoom in and tilts near the ground. Auto follows zoom curves; 2D and 3D ' +
      'hold the view flat or tilted.',
    guide: 'controls.md',
    load: async () => (await views()).viewModes,
  },
  {
    id: 'navigation',
    chapter: 'views',
    title: 'Navigation and tilt policy',
    summary:
      'Mouse, trackpad, touch and keyboard, in a free trackball mode or with north kept up, and a tilt that follows ' +
      'the distance to the ground.',
    guide: 'controls.md#navigation-modes',
    load: async () => (await views()).navigation,
  },
  {
    id: 'camera',
    chapter: 'views',
    title: 'Camera movements',
    summary: 'Flights, eases, fits, guided tours and orbits from code, interrupted by any input.',
    guide: 'integration.md#the-globes-api-at-a-glance',
    load: async () => (await views()).camera,
  },
  {
    id: 'limits',
    chapter: 'views',
    title: 'Camera limits',
    summary: 'Hold the camera within a region, a zoom range and a largest tilt; every gesture and movement obeys.',
    guide: 'controls.md#camera-limits',
    load: async () => (await views()).limits,
  },
  {
    id: 'adapters',
    chapter: 'imagery',
    title: 'Imagery adapters',
    summary:
      'XYZ, WMTS and WMS services, services in other reference systems reprojected on the client, single ' +
      'georeferenced images, and PMTiles, MBTiles and GeoTIFF files from your disk.',
    guide: 'sources.md#imagery-adapters',
    load: async () => (await imagery()).adapters,
  },
  {
    id: 'composition',
    chapter: 'imagery',
    title: 'Layers and source chains',
    summary:
      'Stack imagery layers with opacity and blend modes, and chain sources so each tile comes from the first that ' +
      'has it, its tones matched to the layer below.',
    guide: 'sources.md#layer-composition-and-source-chains',
    load: async () => (await imagery()).composition,
  },
  {
    id: 'europe',
    chapter: 'imagery',
    title: 'Europe preset',
    summary:
      'Satellite, hybrid, map, landscape and relief map types of Europe built only from free sources that allow ' +
      'commercial use, with their exact credits.',
    guide: 'apps/presets/europe-preset.md',
    online: 'NASA GIBS, ESA WorldCover, national orthophotos, OpenFreeMap and Mapterhorn tiles',
    load: async () => (await import('./scenes/europe.js')).europe,
  },
  {
    id: 'relief',
    chapter: 'terrain',
    title: 'Terrain and picking',
    summary:
      'Heightmap terrain under the imagery, shaded by the Sun. The readout gives the height under the pointer; a ' +
      'click picks the ground and pins it.',
    guide: 'terrain.md',
    terrain: 'terrarium',
    load: async () => (await terrain()).relief,
  },
  {
    id: 'real-terrain',
    chapter: 'terrain',
    title: 'Real terrain',
    summary: 'Mapterhorn’s Terrarium tiles of Europe under satellite imagery, down to a few metres.',
    guide: 'terrain.md#elevation-queries',
    terrain: 'mapterhorn',
    online: 'Mapterhorn terrain and the Europe preset’s satellite imagery',
    load: async () => (await terrain()).realTerrain,
  },
  {
    id: 'vector-styles',
    chapter: 'vector',
    title: 'Vector tile styles',
    summary:
      'MapLibre styles drawn from Mapbox Vector Tiles on the globe and the flat map: every layer type, labels in ' +
      'any language, styles changed at runtime and features picked.',
    guide: 'vector-tiles.md',
    load: async () => (await vector()).styles,
  },
  {
    id: 'buildings',
    chapter: 'vector',
    title: '3D buildings',
    summary: 'Building footprints extruded to the heights in their tags, growing from the ground as they appear.',
    guide: 'data-layers.md#buildings',
    load: async () => (await vector()).buildings,
  },
  {
    id: 'openfreemap',
    chapter: 'vector',
    title: 'OpenFreeMap',
    summary: 'A full OpenStreetMap style for the whole world, as a production application would use it.',
    guide: 'vector-tiles.md#styles-and-sources',
    online: 'OpenFreeMap’s Liberty style, tiles, glyphs and sprites',
    load: async () => (await vector()).openFreeMap,
  },
  {
    id: 'markers',
    chapter: 'data',
    title: 'Markers at scale',
    summary:
      '100,000 markers with level of detail: crowded or distant ones become dots that cross-fade to the full marker.',
    guide: 'data-layers.md#primitives',
    load: async () => (await points()).markers,
  },
  {
    id: 'shapes',
    chapter: 'data',
    title: 'Lines, areas and volumes',
    summary:
      'Polygons draped on the ground, extrusions from a property, lines at an altitude, geodesic circles and labels, ' +
      'styled with expressions.',
    guide: 'data-layers.md#placement',
    load: async () => (await shapes()).shapes,
  },
  {
    id: 'live',
    chapter: 'data',
    title: 'Live data and interaction',
    summary: 'Thousands of moving points updated in place, hovered, selected and framed, without rebuilding the layer.',
    guide: 'data-layers.md#live-updates-and-fitting-the-view',
    load: async () => (await points()).live,
  },
  {
    id: 'files',
    chapter: 'data',
    title: 'GeoJSON, KML and GPX',
    summary: 'Load vector files from memory, a URL or your disk; each geometry family draws in its own batch.',
    guide: 'data-layers.md#files-geojson-kml-and-gpx',
    load: async () => (await shapes()).files,
  },
  {
    id: 'energy-park',
    chapter: 'models',
    title: 'Models with moving parts',
    summary:
      'glTF models instanced by the hundred: wind turbines whose nacelles turn into the wind and whose rotors spin, ' +
      'beside a field of solar tables.',
    guide: 'models.md#moving-parts',
    load: async () => (await models()).energyPark,
  },
  {
    id: 'instancing',
    chapter: 'models',
    title: 'Two thousand copies',
    summary: 'One model drawn for every copy in view, a light placeholder beyond a distance you choose.',
    guide: 'models.md#many-copies-of-one-model',
    load: async () => (await models()).instancing,
  },
  {
    id: '3d-tiles',
    chapter: 'models',
    title: '3D Tiles',
    summary: 'An OGC 3D Tiles city streamed by screen-space error, in four encodings, with its features picked.',
    guide: 'models.md#3d-tiles',
    load: async () => (await import('./scenes/tiles3d.js')).city,
  },
  {
    id: 'measure',
    chapter: 'tools',
    title: 'Draw and measure',
    summary: 'Points, lines and polygons drawn and edited on the map, measured on the WGS84 ellipsoid.',
    guide: 'ui-and-gis.md#drawing-with-your-own-toolbar',
    load: async () => (await tools()).measure,
  },
  {
    id: 'coordinates',
    chapter: 'tools',
    title: 'Coordinates and grids',
    summary: 'Read decimal, DMS and UTM coordinates, transform them between reference systems and draw a metric grid.',
    guide: 'ui-and-gis.md#gis-utilities',
    load: async () => (await tools()).coordinates,
  },
  {
    id: 'share',
    chapter: 'tools',
    title: 'Links, bookmarks and images',
    summary: 'The view in the page’s address, saved views, a minimap and a picture of the view with its credits.',
    guide: 'ui-and-gis.md#view-state-in-a-url',
    load: async () => (await tools()).share,
  },
  {
    id: 'offline',
    chapter: 'offline',
    title: 'Offline engine',
    summary:
      'Tiles from a persistent cache, installed packages or the network, per network mode; an area of the map ' +
      'installed as a package in this browser.',
    guide: 'offline.md',
    load: async () => (await import('./scenes/offline.js')).offline,
  },
  {
    id: 'quality',
    chapter: 'performance',
    title: 'Quality and adaptation',
    summary:
      'Quality presets for every device, and a governor that lowers the resolution while frames run late and ' +
      'restores it when the camera rests.',
    guide: 'packages/quality/README.md',
    load: async () => (await speed()).quality,
  },
  {
    id: 'diagnostics',
    chapter: 'performance',
    title: 'Diagnostics',
    summary: 'Frame time, per-phase costs, the tiles drawn and where their imagery comes from.',
    guide: 'debugging.md',
    load: async () => (await speed()).diagnostics,
  },
  {
    id: 'integrations',
    chapter: 'integrations',
    title: 'Vue, Nuxt and Web Component',
    summary:
      'The same engine as a Vue component, in Nuxt without server rendering, as a custom element, or loaded lazily ' +
      'from plain TypeScript.',
    guide: 'integration.md',
    load: async () => (await import('./scenes/integrations.js')).integrations,
  },
];

/** The guide's address on GitHub. */
export function guideUrl(guide: string): string {
  const path = guide.includes('/') ? guide : `docs/guides/${guide}`;
  return `https://github.com/SimoneRecchia/VibeGlobe/blob/main/${path}`;
}
