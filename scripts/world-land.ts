// Writes the world land mask of the Europe preset's world package (F684) and of its pipeline configuration from Natural
// Earth's 1:50m land (public domain), Antarctica left out (WorldCover has no imagery there: the base image shows it),
// simplified to about a kilometre for the pipeline and 2.5 km for the preset. Run once when the tolerance changes:
//   node scripts/world-land.ts <ne_50m_land.geojson>
// The input comes from https://github.com/nvkelso/natural-earth-vector (geojson/ne_50m_land.geojson).
import { readFileSync, writeFileSync } from 'node:fs';
import { encodePolygons } from '../packages/presets/src/polygons.ts';
import { area, round, simplify, type Point, type Ring } from './land-rings.ts';

/** Douglas–Peucker tolerance in degrees of the pipeline's mask (about 1 km in latitude). */
const TOLERANCE_DEG = 0.01;
/** The preset's mask keys the package's sea and bounds online requests: about 2.5 km is enough. */
const PRESET_TOLERANCE_DEG = 0.025;
/** Polygons wholly south of this latitude are Antarctica's. */
const ANTARCTICA_DEG = -60;

const input = process.argv[2];
if (!input) throw new Error('usage: node scripts/world-land.ts <ne_50m_land.geojson>');
interface Land {
  features: { geometry: { type: string; coordinates: number[][][] | number[][][][] } }[];
}
const land = JSON.parse(readFileSync(input, 'utf8')) as Land;

/** The land's polygons but Antarctica's, simplified to `tolerance` degrees. */
function landPolygons(tolerance: number): Ring[][] {
  const polygons: Ring[][] = [];
  for (const { geometry } of land.features) {
    const parts =
      geometry.type === 'Polygon' ? [geometry.coordinates as number[][][]] : (geometry.coordinates as number[][][][]);
    for (const part of parts) {
      const rings = part
        .map((ring) =>
          simplify(
            ring.map(([x, y]) => [x ?? 0, y ?? 0] as Point),
            tolerance,
          ),
        )
        .map((ring) => ring.map(([x, y]) => [round(x), round(y)] as Point))
        .filter((ring) => ring.length >= 4 && area(ring) > 1e-5);
      const outer = rings[0];
      if (outer && area(outer) > 1e-4 && Math.max(...outer.map(([, y]) => y)) > ANTARCTICA_DEG) polygons.push(rings);
    }
  }
  return polygons;
}
const header =
  'Natural Earth 1:50m land but Antarctica (public domain, https://www.naturalearthdata.com), simplified to ' +
  `${TOLERANCE_DEG}° by scripts/world-land.ts.`;
writeFileSync(
  'packages/tools/configs/regions/world-land.geojson',
  `${JSON.stringify({ type: 'Feature', properties: { source: header }, geometry: { type: 'MultiPolygon', coordinates: landPolygons(TOLERANCE_DEG) } })}\n`,
);
writeFileSync(
  'packages/presets/src/world-land.ts',
  `// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The world's land for the Europe preset's world package (F684): \`europeOpen({ worldLand: WORLD_LAND })\` keys the
 * package's sea out on it. A module of its own, so an application loads it only with its world package.
 * @module @vibeglobe/presets/world-land
 */
import type { PolygonDeg } from '@vibeglobe/core';
import { decodePolygons } from './polygons.js';

/** ${header.replace(`${TOLERANCE_DEG}°`, `${PRESET_TOLERANCE_DEG}°`)} */
export const WORLD_LAND: readonly PolygonDeg[] = /* @__PURE__ */ decodePolygons(${JSON.stringify(encodePolygons(landPolygons(PRESET_TOLERANCE_DEG)))});
`,
);
