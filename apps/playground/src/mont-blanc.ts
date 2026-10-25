/**
 * `?scenario=mont-blanc`: real data to judge by eye. The Mont Blanc massif from the dataset pipeline's local sample
 * builds (`packages/tools`, served by `vite.config.ts`): Copernicus DEM GLO-30 terrain and ESA WorldCover
 * Sentinel-2 imagery, with the world-low sample's GLO-90 terrain and coarser WorldCover imagery around them when that
 * build exists, over the bundled Natural Earth base. Each dataset's encoding, levels, bounds and credits come from
 * its `metadata.json`; tiles a build did not write are `noData`, so none is requested.
 */
import type { GlobeOptions, ImagerySource, TerrainSource, TileCoord, TileRequest } from '@vibeglobe/core';
import { heightmapTerrain, xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

/** The scenario's view as URL parameters the URL may override: the summit (45.8326° N, 6.8652° E) from the north. */
export const REAL_DATA: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'mont-blanc': { lon: '6.8652', lat: '45.8326', zoom: '11', tilt: '65', heading: '180' },
};

/** The two builds the scenario needs, as the page names them when they are missing. */
const MONT_BLANC_BUILDS = [
  'node packages/tools/dist/bin.js build packages/tools/configs/test-mont-blanc.json --sample --yes',
  'node packages/tools/dist/bin.js build italy-high.json --sample --yes --dataset imagery',
] as const;

/** The fields of a pipeline `metadata.json` the scenario reads. */
interface DatasetMetadata {
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly format: string;
  readonly encoding: string;
  readonly attribution: string;
  readonly licenseUrl?: string;
}

/** One built dataset: its metadata and the `z/x/y` keys of its tiles. */
interface Dataset {
  readonly base: string;
  readonly metadata: DatasetMetadata;
  readonly tiles: ReadonlySet<string>;
}

/** The scenario's layers; each source's credits come from its dataset's `metadata.json`. */
interface MontBlancData {
  readonly terrain: TerrainSource;
  /** Bottom first: the coarser context imagery (when built), then the sample's. */
  readonly imagery: readonly ImagerySource[];
}

/** Reads one dataset's index from the dev server; undefined when that build has not been run. */
async function dataset(build: string, id: string): Promise<Dataset | undefined> {
  const base = `${import.meta.env.BASE_URL}real-data/${build}/${id}/`;
  const body = (await (await fetch(`${base}index.json`)).json()) as {
    metadata?: DatasetMetadata;
    tiles?: string[];
  };
  return body.metadata ? { base, metadata: body.metadata, tiles: new Set(body.tiles ?? []) } : undefined;
}

const key = (coord: TileCoord): string => `${coord.level}/${coord.x}/${coord.y}`;
const credit = (data: Dataset): { text: string; url?: string } => ({
  text: data.metadata.attribution,
  ...(data.metadata.licenseUrl ? { url: data.metadata.licenseUrl } : {}),
});

/** A tile request function, as terrain and imagery sources declare it. */
type RequestTile = (coord: TileCoord, out: TileRequest) => TileRequest | 'noData' | 'unknown';

/** Replaces a source's `request` with `route`'s choice: `noData` where it returns none, so coarser levels show. */
function onlyBuilt<T extends { request: RequestTile }>(
  source: T,
  route: (coord: TileCoord) => RequestTile | undefined,
): T {
  return Object.assign(source, {
    request: (coord: TileCoord, out: TileRequest) => route(coord)?.(coord, out) ?? 'noData',
  });
}

/** A source's own `request`, kept before {@link onlyBuilt} replaces it. */
const ownRequest = (source: { request: RequestTile }): RequestTile => source.request.bind(source);

/** The terrain: the GLO-30 sample's tiles where it has them, the GLO-90 context's below its levels. */
function terrainOf(fine: Dataset, coarse: Dataset | undefined): TerrainSource {
  const encoding = fine.metadata.encoding === 'terrain-rgb' ? 'terrain-rgb' : 'terrarium';
  const minLevel = Math.min(fine.metadata.minzoom, coarse?.metadata.minzoom ?? Infinity);
  const sourceOf = (data: Dataset): TerrainSource =>
    heightmapTerrain({
      id: 'mont-blanc-terrain',
      url: `${data.base}{z}/{x}/{y}.${data.metadata.format}`,
      encoding,
      minLevel,
      maxLevel: fine.metadata.maxzoom,
      attribution: [fine, ...(coarse ? [coarse] : [])].map(credit),
    });
  const source = sourceOf(fine);
  const fineRequest = ownRequest(source);
  const coarseRequest = coarse ? ownRequest(sourceOf(coarse)) : undefined;
  return onlyBuilt(source, (coord) =>
    fine.tiles.has(key(coord)) ? fineRequest : coarse?.tiles.has(key(coord)) ? coarseRequest : undefined,
  );
}

/**
 * A dataset's imagery as one source per level, coarsest first, each limited to its built tiles. A build clipped to a
 * region (italy-high's polygon) has fewer tiles at each deeper level: one layer per level keeps the deepest built tile
 * in view everywhere, where a single source with `noData` children would show the layer below instead (see the
 * scenario's notes in `apps/playground/CLAUDE.md`).
 */
function imageryOf(data: Dataset, id: string): ImagerySource[] {
  const layers: ImagerySource[] = [];
  for (let level = data.metadata.minzoom; level <= data.metadata.maxzoom; level++) {
    const source = xyzImagery({
      id: `${id}-z${level}`,
      url: `${data.base}{z}/{x}/{y}.${data.metadata.format}`,
      minLevel: level,
      maxLevel: level,
      attribution: [credit(data)],
    });
    const request = ownRequest(source);
    layers.push(onlyBuilt(source, (coord) => (data.tiles.has(key(coord)) ? request : undefined)));
  }
  return layers;
}

/**
 * Loads the scenario's datasets. When the two builds it needs have not been run, it shows the commands that make them
 * over the globe instead and returns undefined: the globe then shows the Natural Earth base alone.
 */
async function montBlancData(params: URLSearchParams): Promise<MontBlancData | undefined> {
  // `&terrainBuild=<folder>` reads the terrain from another build folder of the pipeline (one made with `--out`).
  const terrainBuild = params.get('terrainBuild') ?? 'test-mont-blanc-sample';
  // `&context=0` leaves out the world-low context around the samples.
  const context = params.get('context') === '0' ? 'none' : 'world-low-sample';
  const [terrain, imagery, contextTerrain, contextImagery] = await Promise.all([
    dataset(terrainBuild, 'terrain'),
    dataset('italy-high-sample', 'imagery'),
    dataset(context, 'terrain'),
    dataset(context, 'imagery'),
  ]);
  if (!terrain || !imagery) {
    showMissingBuilds(MONT_BLANC_BUILDS.filter((_, index) => (index === 0 ? !terrain : !imagery)));
    return undefined;
  }
  const layers = [
    ...(contextImagery ? imageryOf(contextImagery, 'mont-blanc-context-imagery') : []),
    ...imageryOf(imagery, 'mont-blanc-imagery'),
  ];
  return { terrain: terrainOf(terrain, contextTerrain), imagery: layers };
}

/** Shows which builds are missing and the commands that make them, over the globe. */
function showMissingBuilds(missing: readonly string[]): void {
  const box = document.createElement('div');
  box.id = 'mont-blanc-missing';
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'position:absolute;left:16px;right:16px;top:16px;padding:12px 16px;background:#202124ee;color:#fff;' +
    'font:14px/1.5 system-ui,sans-serif;border-radius:6px;z-index:10';
  const title = document.createElement('p');
  title.style.margin = '0 0 8px';
  title.textContent =
    'The Mont Blanc scenario needs the dataset pipeline’s sample builds. Run from the repository root (after npm run build):';
  box.append(title);
  for (const command of missing) {
    const code = document.createElement('pre');
    code.style.cssText = 'margin:4px 0;white-space:pre-wrap;font-size:13px';
    code.textContent = command;
    box.append(code);
  }
  (document.querySelector('#app') ?? document.body).append(box);
}

/** The scenario's layers for `createGlobe` with `?scenario=mont-blanc` (read before the globe starts); none otherwise. */
const params = new URLSearchParams(location.search);
const data = params.get('scenario') === 'mont-blanc' ? await montBlancData(params) : undefined;
export const montBlancLayers: Pick<GlobeOptions, 'terrain' | 'imagery' | 'workers'> = data
  ? { terrain: data.terrain, imagery: data.imagery, workers: createWorkers() }
  : {};
