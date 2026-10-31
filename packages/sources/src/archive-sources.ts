// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  heightmapGeometricErrorMeters,
  WEB_MERCATOR_TILING,
  WGS84,
  type TerrainSource,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
  type TileSource,
  type VerticalDatum,
} from '@vibeglobe/core';
import type { Attribution, DescribedImagerySource, DescribedSource } from './metadata.js';
import { inLevelsAndCoverage } from './tiling.js';

/** What the terrain tiles of a package are encoded as (F328). */
export type ArchiveTerrainEncoding = 'terrarium' | 'terrain-rgb' | 'quantized-mesh';

/** Options shared by the terrain sources of packages. */
export interface ArchiveTerrainOptions {
  readonly encoding: ArchiveTerrainEncoding;
  /** Pixels per tile edge of heightmaps (default 256). */
  readonly tileSizePx?: number;
  /** What the heights are measured from; the WGS84 ellipsoid by default. */
  readonly datum?: VerticalDatum;
}

/** A tile source whose tiles are Mapbox Vector Tiles, read through the MVT parser (`@vibeglobe/sources/vector`). */
export interface VectorTileSource extends TileSource {
  readonly attribution: DescribedSource['attribution'];
  readonly profile: DescribedSource['profile'];
  readonly format: 'mvt';
  readonly transportRequired: true;
}

/** The tile-source part of an archive source: addressing, transport, levels, coverage, credits and profile. */
function tilesOf(archive: DescribedImagerySource) {
  return {
    id: archive.id,
    tiling: archive.tiling,
    minLevel: archive.minLevel,
    maxLevel: archive.maxLevel,
    ...(archive.coverage ? { coverage: archive.coverage } : {}),
    ...(archive.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: archive.maxRequestsPerHost }),
    transport: archive.transport,
    request: archive.request.bind(archive),
    attribution: archive.attribution,
    profile: archive.profile,
    transportRequired: true as const,
  };
}

/** Quantized-mesh samples along a level-0 tile edge that its usual geometric error assumes. */
const LEVEL_ZERO_SAMPLES = 65;

/** The same package as terrain: Web Mercator tiles in an archive (XYZ rows), decoded by the engine's workers. */
export function terrainFromArchive(
  archive: DescribedImagerySource,
  options: ArchiveTerrainOptions,
): TerrainSource & DescribedSource {
  const equatorMeters = 2 * Math.PI * WGS84.semiMajorAxisMeters;
  const samples = options.encoding === 'quantized-mesh' ? LEVEL_ZERO_SAMPLES : (options.tileSizePx ?? 256);
  return {
    ...tilesOf(archive),
    decoder: { kind: options.encoding },
    datum: options.datum ?? { kind: 'ellipsoid' },
    geometricErrorMeters: (level) =>
      heightmapGeometricErrorMeters(level, samples, equatorMeters, archive.tiling.rootTilesX),
  };
}

/** The same package as vector tiles. */
export function vectorFromArchive(archive: DescribedImagerySource): VectorTileSource {
  return { ...tilesOf(archive), format: 'mvt' };
}

/**
 * The imagery source of an archive read in the page (PMTiles, MBTiles): 256-pixel Web Mercator images, each tile
 * addressed as `base#z/x/y` for the archive's transport, `noData` outside its levels and coverage.
 */
export function archiveImagery(
  fields: Pick<DescribedImagerySource, 'id' | 'minLevel' | 'maxLevel' | 'attribution' | 'profile' | 'transport'> &
    Partial<Pick<DescribedImagerySource, 'maxRequestsPerHost'>> & { readonly coverage: TileRectangleRad | undefined },
  base: string,
): DescribedImagerySource {
  const { coverage, ...rest } = fields;
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const source: DescribedImagerySource = {
    ...rest,
    tiling: WEB_MERCATOR_TILING,
    tileSizePx: 256,
    pixelRatio: 1,
    ...(coverage ? { coverage: [coverage] } : {}),
    decoder: 'image',
    transportRequired: true,
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (!inLevelsAndCoverage(source, coord, extent)) return 'noData';
      out.url = `${base}#${coord.level}/${coord.x}/${coord.y}`;
      out.hostIndex = 0;
      return out;
    },
  };
  return source;
}

/** The credit an archive records in its metadata (`attribution`, possibly HTML with a link). */
export function htmlAttribution(raw: unknown): Attribution[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const link = /href="([^"]+)"/.exec(raw)?.[1];
  const text = raw.replace(/<[^>]*>/g, '').trim();
  return text.length === 0 ? [] : [link === undefined ? { text } : { text, url: link }];
}
