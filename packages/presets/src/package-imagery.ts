// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Europe preset's satellite imagery from the app's package (F636, F684, F686): Europe's WorldCover in its box, the
 * world's below it, and the sea below both; or, online only, NASA's Blue Marble from GIBS.
 */
import type { CoverageArea, ImagerySource } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import type { Build } from './europe.js';
import { EUROPE_LAND } from './europe-land.js';
import { gibsBlueMarble } from './gibs.js';
import {
  ESA_WORLDCOVER,
  NASA_GIBS_BLUE_MARBLE,
  WORLD_SEA,
  WORLD_WORLDCOVER,
  type PresetSourceRecord,
} from './sources.js';

/**
 * The fade, in pixels of a tile, of WorldCover at the package box's edge (F639): a few screen pixels at every level, so
 * no border shows between it and the base image.
 */
const FEATHER_PX = 12;

/**
 * How far inside `EUROPE_LAND` the package's water fades back in (KB-303): more than the outline's simplification
 * (0.025°, about 2.8 km) and the gaps it leaves between countries (up to about 3.2 km), so neither shows.
 */
const SEA_FEATHER_METERS = 4000;

/** The whole Web Mercator world, the box of the world's imagery (F684). */
const WORLD_BOX = [
  [
    [-180, -85.06],
    [180, -85.06],
    [180, 85.06],
    [-180, 85.06],
    [-180, -85.06],
  ],
] as const;

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

/** NASA's Blue Marble below the satellite: the package's sea with its levels (F686), else GIBS's online only. */
export function baseSource(build: Build): ImagerySource | undefined {
  const seaLevel = build.options.packageLevels?.sea;
  if (build.packaged && seaLevel !== undefined && build.use(WORLD_SEA))
    return packageImagery(build, WORLD_SEA, 'sea', 0, { polygons: [WORLD_BOX] }, seaLevel);
  if (!build.packaged && build.use(NASA_GIBS_BLUE_MARBLE))
    return build.wrap(gibsBlueMarble(NASA_GIBS_BLUE_MARBLE), 'network', 'satellite');
  return undefined;
}

/**
 * The package's WorldCover (F636, F684): Europe's within its box and, with the world's land, the world's at the lower
 * levels below it, Europe's then starting above them.
 */
export function packageSources(build: Build, far: number): ImagerySource[] {
  const { options } = build;
  const sources: ImagerySource[] = [];
  const worldLevel = options.packageLevels?.world ?? WORLD_WORLDCOVER.maxLevel;
  const world = build.packaged && options.worldLand !== undefined && build.use(WORLD_WORLDCOVER);
  // The package's box with a soft edge. Its sea, real water near the coast and a flat no-data color (RGB 54, 73, 90)
  // beyond, each ending in rectangles, is transparent outside the land; inside it nothing is keyed, as deep lakes and
  // shadows can have that color too (KB-303).
  if (build.packaged && build.use(ESA_WORLDCOVER))
    sources.push(
      packageImagery(
        build,
        ESA_WORLDCOVER,
        'imagery',
        world ? worldLevel + 1 : Math.max(ESA_WORLDCOVER.minLevel, far + 1),
        {
          polygons: [PACKAGE_BOX],
          tiles: 'clip',
          featherPx: FEATHER_PX,
          keySea: { land: EUROPE_LAND, featherMeters: SEA_FEATHER_METERS },
        },
      ),
    );
  if (world && options.worldLand)
    sources.push(
      packageImagery(
        build,
        WORLD_WORLDCOVER,
        'world-imagery',
        Math.max(WORLD_WORLDCOVER.minLevel, far + 1),
        {
          polygons: [WORLD_BOX],
          keySea: { land: options.worldLand, featherMeters: SEA_FEATHER_METERS },
        },
        worldLevel,
      ),
    );
  return sources;
}

/** A package dataset as imagery: never fetched, the tiles come from the package and the URL only names them. */
function packageImagery(
  build: Build,
  record: PresetSourceRecord,
  folder: string,
  minLevel: number,
  area: CoverageArea,
  maxLevel = build.options.packageLevels?.imagery ?? record.maxLevel,
): ImagerySource {
  const source = xyzImagery({
    id: record.id,
    url: `${build.packageBase}${folder}/{z}/{x}/{y}.jpg`,
    minLevel,
    maxLevel,
    area,
    attribution: record.attribution,
  });
  return build.wrap(source, 'package', 'satellite');
}
