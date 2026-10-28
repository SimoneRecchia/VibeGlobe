// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `europeOpen`: Google Earth-like map types of Europe from free sources whose terms allow commercial use and
 * redistribution (ADR 0182). In hybrid use the app's offline package, on its own server, holds every level up to its
 * own and the sea; online detail on land loads beyond it, tile by tile.
 */
import {
  coverageTest,
  WEB_MERCATOR_TILING,
  type ImageryLayerOptions,
  type PolarCapColors,
  type ImagerySource,
  type TerrainSource,
  type TileRectangleRad,
  type TileSource,
} from '@vibeglobe/core';
import { heightmapTerrain, xyzImagery } from '@vibeglobe/sources';
import { EUROPE_BOUNDS, EUROPE_LAND } from './europe-land.js';
import {
  EXCLUDED_SOURCES,
  ESA_WORLDCOVER,
  MAPTERHORN,
  COPERNICUS_GLO30,
  NASA_GIBS_BLUE_MARBLE,
  OPENFREEMAP,
  WORLDCOVER_WATER_RGB,
  type ExcludedSource,
  type PresetSourceRecord,
  type SourceTiers,
} from './sources.js';
import type { OrthophotoLayers } from './orthophotos.js';
import { composeStyle, type HillshadeSource, type StyleJson, type StyleSelection } from './styles.js';
import { gibsBlueMarble } from './gibs.js';
import { POLITICAL_COLORS } from './political-style.js';

/** The offline engine, as far as the preset uses it (`createOffline()` of `@vibeglobe/offline`). */
export interface OfflineWrapper {
  source<S extends TileSource>(source: S, options: { tiers?: SourceTiers; layerId?: string }): S;
}

/** A source of the app's own (a customer's provider with its key, a national orthophoto), added to a layer. */
export interface AddedSource {
  /** The engine source; give it its `area` so it is asked only where it has data. */
  readonly source: ImagerySource;
  /** Its terms, listed with the preset's. */
  readonly record: PresetSourceRecord;
  /** `top` (default): asked first, above the preset's; `bottom`: only where nothing else has data. */
  readonly position?: 'top' | 'bottom';
}

/** Options of {@link europeOpen}. */
export interface EuropeOpenOptions {
  /**
   * The manifest of the app's offline package (built by the `europe.json` pipeline configuration and published on the
   * app's server). Without it the preset is online only: no package-backed source.
   */
  readonly packageManifestUrl?: string;
  /** The package's static tile folders (vector tiles, terrain for the hillshade); by default next to the manifest. */
  readonly packageBaseUrl?: string;
  /** The deepest level each online source is asked for, by source id (`openfreemap`, `europe-terrain`, …). */
  readonly onlineMaxLevel?: Readonly<Record<string, number>>;
  /** Source ids to leave out. */
  readonly exclude?: readonly string[];
  /** The app's own imagery sources, added to the satellite layer. */
  readonly addSources?: readonly AddedSource[];
  /** Wraps each source with its tiers; required with a package (the package-only sources need it). */
  readonly offline?: OfflineWrapper;
  /**
   * National and regional orthophotos, each clipped to its borders, above the satellite composite in Satellite and
   * Hybrid: `await europeOrthophotos()` of `@vibeglobe/presets/orthophotos` (ADR 0182).
   */
  readonly orthophotos?: OrthophotoLayers;
  /**
   * The deepest level of the package's vector tiles and terrain on land (the `maxZoom` of `europe-vectors` and
   * `europe-terrain` in its pipeline configuration; 11 by default, as in `europe.json`).
   */
  readonly packageLevels?: { readonly vectors?: number; readonly terrain?: number };
}

/** Where the map's vector style and hillshade read their files from. */
export type PresetMode = 'online' | 'hybrid' | 'offline';

/** A base map type. */
export interface BaseMap {
  readonly id: 'satellite' | 'hybrid' | 'map' | 'relief';
  readonly name: string;
  /** The imagery layers (`Globe.imageryLayers.set`). */
  readonly imagery: readonly ImageryLayerOptions[];
  /** The vector style parts drawn over the imagery. */
  readonly style: StyleSelection;
  /**
   * The polar caps' fill beyond 85.05° (`Globe.setPolarCapColors`) where no imagery covers them: the political map's
   * water in the north (all sea there) and its land in the south (Antarctica), so Map and Relief look the same up to
   * the poles. Undefined for Satellite and Hybrid, whose Blue Marble covers the caps.
   */
  readonly polarCapColors?: PolarCapColors;
}

/** An overlay, shown over any base map. */
export interface Overlay {
  readonly id: 'labels' | 'roads' | 'buildings' | 'terrain';
  readonly name: string;
  /** The vector style parts it adds; none for 3D terrain. */
  readonly style: StyleSelection;
}

/** The Europe preset. */
export interface EuropePreset {
  readonly baseMaps: readonly BaseMap[];
  readonly overlays: readonly Overlay[];
  /** The 3D terrain (`GlobeOptions.terrain`, chosen when the globe is created); undefined when excluded. */
  readonly terrain: TerrainSource | undefined;
  /** Every source used, with its terms. */
  readonly sources: readonly PresetSourceRecord[];
  /** The sources left out, with why. */
  readonly excluded: readonly ExcludedSource[];
  /** The package manifest to serve (`PackageManager.addServedPackage`), when given. */
  readonly packageManifestUrl: string | undefined;
  /** The vector style URL the Map and the overlays derive from: online, or the package's copy offline. */
  readonly styleUrl: (mode: 'online' | 'offline') => string;
  /**
   * The `transformUrl` of `addVectorTiles` for the style's files in a mode: hybrid reads vector and hillshade tiles
   * from the package up to its levels, and over the sea always (a tile it does not hold is drawn from its nearest
   * ancestor), the network beyond on land; offline reads every file from the package's mirror of OpenFreeMap's
   * style, fonts and sprites (`openfreemap/` next to the manifest) and every tile from the package.
   */
  transformUrl(mode: PresetMode): (url: string) => string;
  /**
   * The style of a base map with overlays, from the loaded style JSON ({@link EuropePreset.styleUrl}); undefined when
   * the selection draws no vector layer.
   */
  styleFor(style: StyleJson, baseId: BaseMap['id'], overlayIds: readonly Overlay['id'][]): StyleJson | undefined;
}

const LAND = { polygons: EUROPE_LAND, tiles: 'overlap' as const };
const OPENFREEMAP_ORIGIN = 'https://tiles.openfreemap.org/';
/** A tile URL's level, column and row: OpenFreeMap's `…/{z}/{x}/{y}.pbf`, Mapterhorn's `…/{z}/{x}/{y}.webp`. */
const TILE_PATH = /\/(\d+)\/(\d+)\/(\d+)\.(pbf|webp)$/;

function levelOf(options: EuropeOpenOptions, record: PresetSourceRecord): number {
  return Math.min(options.onlineMaxLevel?.[record.id] ?? record.maxLevel, record.maxLevel);
}

/** What building the preset shares between its parts. */
interface Build {
  readonly options: EuropeOpenOptions;
  readonly packaged: boolean;
  readonly packageBase: string;
  readonly used: PresetSourceRecord[];
  wrap<S extends TileSource>(source: S, tiers: SourceTiers, layerId: string): S;
  /** Lists the source unless excluded; false when excluded. */
  use(record: PresetSourceRecord): boolean;
}

/**
 * The fade, in pixels of a tile, from the Blue Marble to WorldCover at the edge of Europe's land and of the water keyed
 * out over the sea (KB-231): a few screen pixels at every level, so no border shows between the sources.
 */
const FEATHER_PX = 12;

/**
 * Satellite, two layers (KB-231). Below, NASA's Blue Marble everywhere: the whole world at the lowest levels, the sea at
 * every level, and the land outside Europe. Above, the app's sources first (national orthophotos are layers of their
 * own above), then the package's WorldCover, whose water is keyed out outside Europe's land with a soft edge: the sea
 * shows the Blue Marble at every level, with WorldCover's own coastline and its lakes on land.
 */
function satelliteLayers(build: Build): ImageryLayerOptions[] {
  const { options, wrap, use } = build;
  const added = (position: 'top' | 'bottom') =>
    (options.addSources ?? [])
      .filter((a) => (a.position ?? 'top') === position && use(a.record))
      .map((a) => wrap(a.source, 'network', 'satellite'));
  const satellite: ImagerySource[] = [...added('top')];
  if (build.packaged && use(ESA_WORLDCOVER))
    satellite.push(
      wrap(
        xyzImagery({
          id: ESA_WORLDCOVER.id,
          // Never fetched: the tiles come from the package, the URL only names them.
          url: `${build.packageBase}imagery/{z}/{x}/{y}.jpg`,
          minLevel: ESA_WORLDCOVER.minLevel,
          maxLevel: ESA_WORLDCOVER.maxLevel,
          area: { polygons: EUROPE_LAND, keyOutside: { rgb: WORLDCOVER_WATER_RGB }, featherPx: FEATHER_PX },
          attribution: ESA_WORLDCOVER.attribution,
        }),
        'package',
        'satellite',
      ),
    );
  satellite.push(...added('bottom'));
  const base = use(NASA_GIBS_BLUE_MARBLE)
    ? [{ id: 'satellite-base', sources: [wrap(gibsBlueMarble(NASA_GIBS_BLUE_MARBLE), 'network', 'satellite')] }]
    : [];
  return [...base, ...(satellite.length > 0 ? [{ id: 'satellite', sources: satellite }] : [])];
}

/** Terrain: the package's extract first, then online on land up to the online level. */
function terrainSource(build: Build): TerrainSource | undefined {
  if (!build.use(MAPTERHORN)) return undefined;
  if (build.packaged) build.used.push(COPERNICUS_GLO30);
  return build.wrap(
    heightmapTerrain({
      id: MAPTERHORN.id,
      url: MAPTERHORN.url ?? '',
      encoding: 'terrarium',
      tileSizePx: 512,
      maxLevel: levelOf(build.options, MAPTERHORN),
      area: LAND,
      attribution: build.packaged
        ? [...MAPTERHORN.attribution, ...COPERNICUS_GLO30.attribution]
        : MAPTERHORN.attribution,
    }),
    build.packaged ? 'all' : 'network',
    'terrain',
  );
}

/** The base maps and overlays the included sources allow. */
function mapTypes(
  imagery: readonly ImageryLayerOptions[],
  vectors: boolean,
  terrain: boolean,
): { baseMaps: BaseMap[]; overlays: Overlay[] } {
  const baseMaps: BaseMap[] = [
    { id: 'satellite', name: 'Satellite', imagery, style: {} },
    { id: 'hybrid', name: 'Hybrid', imagery, style: vectors ? { labels: true, roads: true } : {} },
  ];
  const polarCapColors = { north: POLITICAL_COLORS.water, south: POLITICAL_COLORS.land };
  if (vectors) baseMaps.push({ id: 'map', name: 'Map', imagery: [], style: { map: true }, polarCapColors });
  if (terrain)
    baseMaps.push({
      id: 'relief',
      name: 'Relief',
      imagery: [],
      style: vectors ? { map: true, hillshade: true } : { hillshade: true },
      polarCapColors,
    });
  const overlays: Overlay[] = [];
  if (vectors)
    overlays.push(
      { id: 'labels', name: 'Labels and borders', style: { labels: true } },
      { id: 'roads', name: 'Roads', style: { roads: true } },
      { id: 'buildings', name: '3D buildings', style: { buildings: true } },
    );
  if (terrain) overlays.push({ id: 'terrain', name: '3D terrain', style: {} });
  return { baseMaps, overlays };
}

/** The style of a selection, its vector tiles asked for up to their online level (deeper levels magnify it). */
function selectionStyle(
  style: StyleJson,
  selection: StyleSelection,
  hillshade: HillshadeSource | undefined,
  vectorMax: number,
): StyleJson | undefined {
  const composed = composeStyle(style, selection, hillshade);
  if (composed === undefined) return undefined;
  const sources = Object.fromEntries(
    Object.entries(composed.sources).map(([id, source]) => [
      id,
      source['type'] === 'vector'
        ? { ...source, maxzoom: Math.min(Number(source['maxzoom'] ?? vectorMax), vectorMax) }
        : source,
    ]),
  );
  return { ...composed, sources };
}

/** The package's files in place of the online ones (see {@link EuropePreset.transformUrl}). */
function packageUrls(build: Build, mode: PresetMode): (url: string) => string {
  if (mode === 'online' || !build.packaged) return (url) => url;
  const [west, south, east, north] = EUROPE_BOUNDS;
  const land = coverageTest(LAND);
  const region = coverageTest({
    polygons: [
      [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
        ],
      ],
    ],
    tiles: 'overlap',
  });
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const levels = { pbf: build.options.packageLevels?.vectors ?? 11, webp: build.options.packageLevels?.terrain ?? 11 };
  const terrainOrigin = MAPTERHORN.url?.replace(/\{z\}.*/, '') ?? '';
  return (url) => {
    const tile = TILE_PATH.exec(url);
    if (!tile || !(url.startsWith(OPENFREEMAP_ORIGIN) || url.startsWith(terrainOrigin)))
      // The style, its TileJSON, fonts and sprites: the package's mirror offline, the network otherwise.
      return mode === 'offline' && url.startsWith(OPENFREEMAP_ORIGIN)
        ? `${build.packageBase}openfreemap/${url.slice(OPENFREEMAP_ORIGIN.length)}`
        : url;
    const [, z, x, y, extension] = tile as unknown as [string, string, string, string, 'pbf' | 'webp'];
    const tileExtent = WEB_MERCATOR_TILING.tileExtent(
      { root: 0, level: Number(z), x: Number(x), y: Number(y) },
      extent,
    );
    // Hybrid: the package up to its levels within its region, and over the sea at any level; the network on land
    // beyond them and outside the region.
    const packaged =
      mode === 'offline' || (region.covers(tileExtent) && (Number(z) <= levels[extension] || !land.covers(tileExtent)));
    const dataset = extension === 'pbf' ? 'europe-vectors' : 'europe-terrain';
    return packaged ? `${build.packageBase}${dataset}/${z}/${x}/${y}.${extension}` : url;
  };
}

/** The Europe preset of free map types (ADR 0182). */
export function europeOpen(options: EuropeOpenOptions = {}): EuropePreset {
  const excluded = new Set(options.exclude ?? []);
  const packaged = options.packageManifestUrl !== undefined;
  if (packaged && options.offline === undefined)
    throw new Error('europeOpen: a packageManifestUrl needs the offline engine (options.offline)');
  const used: PresetSourceRecord[] = [];
  const build: Build = {
    options,
    packaged,
    packageBase: options.packageBaseUrl ?? options.packageManifestUrl?.replace(/[^/]*$/, '') ?? '',
    used,
    wrap: (source, tiers, layerId) => (options.offline ? options.offline.source(source, { tiers, layerId }) : source),
    use: (record) => {
      if (excluded.has(record.id)) return false;
      used.push(record);
      return true;
    },
  };
  const imagery = [...satelliteLayers(build), ...(options.orthophotos?.layers ?? [])];
  used.push(...(options.orthophotos?.sources ?? []));
  const terrain = terrainSource(build);
  const vectors = build.use(OPENFREEMAP);
  const hillshade: HillshadeSource | undefined = terrain
    ? {
        tiles: [MAPTERHORN.url ?? ''],
        maxzoom: levelOf(options, MAPTERHORN),
        tileSize: 512,
        attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
      }
    : undefined;
  const { baseMaps, overlays } = mapTypes(imagery, vectors, terrain !== undefined);
  return {
    baseMaps,
    overlays,
    terrain,
    sources: used,
    excluded: EXCLUDED_SOURCES.filter((s) => !used.some((u) => u.id === s.id)),
    packageManifestUrl: options.packageManifestUrl,
    styleUrl: (mode) =>
      mode === 'offline' && packaged ? `${build.packageBase}openfreemap/styles/liberty` : (OPENFREEMAP.url ?? ''),
    transformUrl: (mode) => packageUrls(build, mode),
    styleFor(style, baseId, overlayIds) {
      const parts = [
        baseMaps.find((b) => b.id === baseId)?.style,
        ...overlayIds.map((id) => overlays.find((o) => o.id === id)?.style),
      ];
      const selection: StyleSelection = Object.assign({}, ...parts.filter((p) => p !== undefined));
      return selectionStyle(style, selection, hillshade, levelOf(options, OPENFREEMAP));
    },
  };
}
