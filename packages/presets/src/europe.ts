// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `europeOpen`: Google Earth-like map types of Europe from free sources whose terms allow commercial use and
 * redistribution (ADR 0182). In hybrid use the app's offline package, on its own server, holds every level up to its
 * own and the sea; online detail on land loads beyond it, tile by tile.
 */
import {
  WEB_MERCATOR_TILING,
  type ImageryLayerOptions,
  type PolarCapColors,
  type ImagerySource,
  type TerrainSource,
  type TileRectangleRad,
  type TileSource,
} from '@vibeglobe/core';
import { coverageTest } from '@vibeglobe/core/coverage';
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
import { LANDSCAPE_COLORS } from './landscape-style.js';
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
   * The deepest level of the package's vector tiles, terrain and satellite imagery on land (the `maxZoom` of
   * `europe-vectors`, `europe-terrain` and `europe-satellite` in its pipeline configuration; 11 by default, as in
   * `europe.json`). The imagery built to 13 shows WorldCover's 10 m detail in full where no orthophoto covers the land
   * (F662); the orthophotos still fade in from level 12, above it.
   */
  readonly packageLevels?: { readonly vectors?: number; readonly terrain?: number; readonly imagery?: number };
  /**
   * The far levels, 0 to this one (4 by default), that show the globe's base image (`GlobeOptions.baseImageryUrl`,
   * Natural Earth in the guides) in Satellite and Hybrid: NASA's Blue Marble fades in over the next half level, the
   * package's WorldCover over the level after (F636).
   */
  readonly farLevels?: number;
  /**
   * The Landscape map's land cover far away (F644), where the vector tiles hold none (below level 7): an image source
   * of the app's, in the Landscape's colors, with its terms. The guide shows how to make one from NASA's MODIS land
   * cover (public domain) with `singleImage` of `@vibeglobe/sources`. Without it the land is one color there.
   */
  readonly landCover?: AddedSource;
}

/** Where the map's vector style and hillshade read their files from. */
export type PresetMode = 'online' | 'hybrid' | 'offline';

/** A base map type. */
export interface BaseMap {
  readonly id: 'satellite' | 'hybrid' | 'map' | 'landscape' | 'relief';
  readonly name: string;
  /** The imagery layers (`Globe.imageryLayers.set`). */
  readonly imagery: readonly ImageryLayerOptions[];
  /** The vector style parts drawn over the imagery. */
  readonly style: StyleSelection;
  /**
   * The polar caps' fill beyond 85.05° (`Globe.setPolarCapColors`) where no imagery covers them: the political map's
   * water in the north (all sea there) and its land in the south (Antarctica), so Map and Relief look the same up to
   * the poles; Natural Earth's for Satellite and Hybrid, whose base image shows at the far levels (the Blue Marble
   * covers the caps nearer, F636).
   */
  readonly polarCapColors?: PolarCapColors;
}

/** An overlay, shown over any base map. */
export interface Overlay {
  readonly id: 'labels' | 'roads' | 'buildings' | 'terrain' | 'borders' | 'countries' | 'seas';
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
   * the selection draws no vector layer. Names are in `language` where the tiles have it (such as `it`), else in their
   * Latin or local name (F645).
   */
  styleFor(
    style: StyleJson,
    baseId: BaseMap['id'],
    overlayIds: readonly Overlay['id'][],
    language?: string,
  ): StyleJson | undefined;
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
 * How far a pixel of the package's JPEG tiles may be from its water color and still be keyed out, per channel: the
 * key fades back in up to twice this, so the compression's noise around the coast goes too, while the darkest land
 * (forest, about RGB 98, 110, 94) stays.
 */
const WATER_TOLERANCE = 16;

/**
 * A layer's fade with the zoom from imagery levels (F636): the Mercator zoom shows tiles of 256 pixels of about one level
 * more at the screen's center (the zoom counts tiles of 512 pixels), so level `from` starts at zoom `from - 1`.
 */
function levelFade(fromLevel: number, toLevel: number): { readonly fromZoom: number; readonly toZoom: number } {
  return { fromZoom: fromLevel - 1, toZoom: toLevel - 1 };
}

/** The deepest level of the package's WorldCover: above it, the online sources (F632). */
const PACKAGE_IMAGERY_LEVEL = ESA_WORLDCOVER.maxLevel;

/** The package's box, as `europe.json`'s region: every level of its imagery up to `seaMaxZoom` covers it, land and sea. */
const PACKAGE_BOX = [
  [
    [-32, 27],
    [45, 27],
    [45, 72],
    [-32, 72],
    [-32, 27],
  ],
] as const;

/**
 * Satellite, by zoom (F636, F639). With a package: the globe's base image (Natural Earth) at the far levels and, below
 * everything at every level, over the sea and the polar caps; the package's WorldCover fading in over it within the
 * package's box, its flat water transparent everywhere, its edges soft; where the package holds Europe's land only
 * (from level 9) its level 8 tiles magnified elsewhere, so Turkey's or Morocco's land keeps the same source; above the
 * package's levels the app's finer online sources, fading in over a level. WorldCover's tones match the base image's
 * at the lowest levels, fading to its own by level 9, never darkened (F638); the online sources keep their own. Online
 * only, NASA's Blue Marble fades in over the base image instead.
 */
function satelliteLayers(build: Build): ImageryLayerOptions[] {
  const { options, wrap, use } = build;
  const far = options.farLevels ?? 4;
  // `use` lists a source's terms: each added source is asked once.
  const used = (options.addSources ?? []).filter((a) => use(a.record));
  const added = (position: 'top' | 'bottom', online: boolean) =>
    used
      .filter((a) => (a.position ?? 'top') === position && a.source.minLevel > PACKAGE_IMAGERY_LEVEL === online)
      .map((a) => wrap(a.source, 'network', 'satellite'));
  const satellite: ImagerySource[] = [...added('top', false)];
  if (build.packaged && use(ESA_WORLDCOVER))
    satellite.push(
      wrap(
        xyzImagery({
          id: ESA_WORLDCOVER.id,
          // Never fetched: the tiles come from the package, the URL only names them.
          url: `${build.packageBase}imagery/{z}/{x}/{y}.jpg`,
          minLevel: Math.max(ESA_WORLDCOVER.minLevel, far + 1),
          maxLevel: options.packageLevels?.imagery ?? ESA_WORLDCOVER.maxLevel,
          // The package's box with a soft edge; its flat water is no imagery: transparent everywhere (F636).
          area: {
            polygons: [PACKAGE_BOX],
            tiles: 'clip',
            featherPx: FEATHER_PX,
            keyEverywhere: { rgb: WORLDCOVER_WATER_RGB, tolerance: WATER_TOLERANCE },
          },
          attribution: ESA_WORLDCOVER.attribution,
        }),
        'package',
        'satellite',
      ),
    );
  satellite.push(...added('bottom', false));
  const online = [...added('top', true), ...added('bottom', true)];
  const layers: ImageryLayerOptions[] = [];
  if (!build.packaged && use(NASA_GIBS_BLUE_MARBLE))
    layers.push({
      id: 'satellite-base',
      sources: [wrap(gibsBlueMarble(NASA_GIBS_BLUE_MARBLE), 'network', 'satellite')],
      // Its colors stay its own: one gain cannot bring both its sea and its land to the base image's (F636).
      harmonize: false,
      fadeIn: levelFade(far + 0.5, far + 1),
    });
  if (satellite.length > 0)
    layers.push({
      id: 'satellite',
      sources: satellite,
      harmonize: 'below',
      harmonizeFade: levelFade(far + 2, far + 5),
      fadeIn: levelFade(far + 1, far + 2),
    });
  // Finer imagery keeps its own colors (F638).
  if (online.length > 0)
    layers.push({ id: 'satellite-online', sources: online, harmonize: false, fadeIn: onlineFade() });
  return layers;
}

/** The fade-in of the online sources above the package's levels, over the level after its last (F636). */
export function onlineFade(): { readonly fromZoom: number; readonly toZoom: number } {
  return levelFade(PACKAGE_IMAGERY_LEVEL + 1, PACKAGE_IMAGERY_LEVEL + 2);
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

/**
 * Natural Earth's colors beyond 85.05° (the mean of its rows there in `NE1_50M_SR_W`): the polar caps of Satellite and
 * Hybrid at the far levels, where the globe's base image shows (F636).
 */
const NATURAL_EARTH_CAPS = { north: '#7aacd0', south: '#eef1f6' } as const;

/** The base maps and overlays the included sources allow. */
function mapTypes(
  imagery: readonly ImageryLayerOptions[],
  vectors: boolean,
  terrain: boolean,
  landCover: ImageryLayerOptions | undefined,
): { baseMaps: BaseMap[]; overlays: Overlay[] } {
  // At the far levels the base image's polar caps show: Natural Earth's colors there (F636).
  const naturalCaps = NATURAL_EARTH_CAPS;
  const baseMaps: BaseMap[] = [
    { id: 'satellite', name: 'Satellite', imagery, style: {}, polarCapColors: naturalCaps },
    {
      id: 'hybrid',
      name: 'Hybrid',
      imagery,
      style: vectors ? { labels: true, roads: true } : {},
      polarCapColors: naturalCaps,
    },
  ];
  const polarCapColors = { north: POLITICAL_COLORS.water, south: POLITICAL_COLORS.land };
  if (vectors)
    baseMaps.push(
      { id: 'map', name: 'Map', imagery: [], style: { map: true }, polarCapColors },
      {
        id: 'landscape',
        name: 'Landscape',
        imagery: landCover ? [landCover] : [],
        style: { landscape: true, hillshade: terrain, landCoverImage: landCover !== undefined },
        polarCapColors: { north: LANDSCAPE_COLORS.water, south: LANDSCAPE_COLORS.ice },
      },
    );
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
      { id: 'borders', name: 'Borders', style: { borders: true } },
      { id: 'countries', name: 'Country names', style: { countries: true } },
      { id: 'seas', name: 'Sea names', style: { seas: true } },
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
  const cover = options.landCover;
  const landCover =
    cover && build.use(cover.record)
      ? { id: 'landscape-land-cover', sources: [cover.source], harmonize: false }
      : undefined;
  const { baseMaps, overlays } = mapTypes(imagery, vectors, terrain !== undefined, landCover);
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
    styleFor(style, baseId, overlayIds, language) {
      const parts = [
        baseMaps.find((b) => b.id === baseId)?.style,
        ...overlayIds.map((id) => overlays.find((o) => o.id === id)?.style),
      ];
      const selection: StyleSelection = Object.assign({ language }, ...parts.filter((p) => p !== undefined));
      return selectionStyle(style, selection, hillshade, levelOf(options, OPENFREEMAP));
    },
  };
}
