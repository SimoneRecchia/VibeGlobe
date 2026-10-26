// Writes the Europe land mask of the Europe preset and its pipeline configuration from Natural Earth's 1:50m countries
// (public domain): the countries Natural Earth places in Europe, and Cyprus, clipped to Europe's bounds and simplified
// to about a kilometre; with the 1:10m countries too, the preset's country borders for sources clipped to a country
// (`@vibeglobe/presets/countries`, F618). Run once when the bounds, the countries or the tolerance change:
//   node scripts/europe-land.ts <ne_50m_admin_0_countries.geojson> [<ne_10m_admin_0_countries.geojson>]
// The inputs come from https://github.com/nvkelso/natural-earth-vector (geojson/ne_*_admin_0_countries.geojson).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** West, south, east, north in degrees: mainland Europe, Iceland, the Azores, Madeira and the Canary Islands. */
const EUROPE_BOUNDS = [-32, 27, 45, 72] as const;
/** Douglas–Peucker tolerance in degrees of the pipeline's mask (about 1 km in latitude). */
const TOLERANCE_DEG = 0.01;
/** The preset's mask, bundled with the application, only bounds online requests: about 2.5 km is enough. */
const PRESET_TOLERANCE_DEG = 0.025;
/** The country borders clip imagery per pixel: about 300 m, near the 1:10m data's own accuracy. */
const COUNTRY_TOLERANCE_DEG = 0.003;

type Point = [number, number];
type Ring = Point[];

/** Sutherland–Hodgman clipping of a ring to the bounds. */
function clipRing(ring: Ring, [west, south, east, north]: readonly number[]): Ring {
  const edges: [(p: Point) => boolean, (a: Point, b: Point) => Point][] = [
    [(p) => p[0] >= (west ?? 0), (a, b) => at(a, b, 0, west ?? 0)],
    [(p) => p[0] <= (east ?? 0), (a, b) => at(a, b, 0, east ?? 0)],
    [(p) => p[1] >= (south ?? 0), (a, b) => at(a, b, 1, south ?? 0)],
    [(p) => p[1] <= (north ?? 0), (a, b) => at(a, b, 1, north ?? 0)],
  ];
  let out = ring;
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i] as Point;
      const previous = input[(i + input.length - 1) % input.length] as Point;
      if (inside(current)) {
        if (!inside(previous)) out.push(cross(previous, current));
        out.push(current);
      } else if (inside(previous)) out.push(cross(previous, current));
    }
  }
  return out;
}

/** The point of segment a–b where coordinate `axis` equals `value`. */
function at(a: Point, b: Point, axis: 0 | 1, value: number): Point {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  return [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
}

const round = (v: number): number => Math.round(v * 1e3) / 1e3;

/** Douglas–Peucker simplification of an open polyline. */
function simplify(points: Ring, tolerance: number): Ring {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    const [ax, ay] = points[first] as Point;
    const [bx, by] = points[last] as Point;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i] as Point;
      const length = Math.hypot(bx - ax, by - ay);
      const d =
        length === 0 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length;
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (worst > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function area(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i] as Point;
    const [x1, y1] = ring[(i + 1) % ring.length] as Point;
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

const input = process.argv[2];
if (!input) throw new Error('usage: node scripts/europe-land.ts <ne_50m_admin_0_countries.geojson>');
/** Countries Natural Earth places in Asia that the preset counts as Europe. */
const ALSO_EUROPE = new Set(['Cyprus']);
interface Countries {
  features: {
    properties: { CONTINENT?: string; NAME?: string; ISO_A2_EH?: string };
    geometry: { type: string; coordinates: number[][][] | number[][][][] };
  }[];
}
const countries = JSON.parse(readFileSync(input, 'utf8')) as Countries;

/** The polygons of a country, clipped and simplified to `tolerance` degrees. */
function countryPolygons(feature: Countries['features'][number], tolerance: number): Ring[][] {
  const polygons: Ring[][] = [];
  const parts =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates as number[][][]]
      : (feature.geometry.coordinates as number[][][][]);
  for (const part of parts) {
    const rings = part
      .map((ring) =>
        clipRing(
          ring.map(([x, y]) => [x ?? 0, y ?? 0] as Point),
          EUROPE_BOUNDS,
        ),
      )
      .filter((ring) => ring.length >= 3)
      .map((ring) => simplify([...ring, ring[0] as Point], tolerance).map(([x, y]) => [round(x), round(y)] as Point))
      .filter((ring) => ring.length >= 4 && area(ring) > 1e-5);
    if (rings.length > 0 && rings[0] !== undefined) polygons.push(rings);
  }
  return polygons;
}

const inEurope = (feature: Countries['features'][number]): boolean =>
  feature.properties.CONTINENT === 'Europe' || ALSO_EUROPE.has(feature.properties.NAME ?? '');

/** The country polygons of Europe, clipped and simplified to `tolerance` degrees. */
function europePolygons(tolerance: number): Ring[][] {
  const polygons: Ring[][] = [];
  for (const feature of countries.features) {
    if (!inEurope(feature)) continue;
    // Islands smaller than about 1 km² do not bound requests (the land mask's old threshold).
    polygons.push(...countryPolygons(feature, tolerance).filter((p) => area(p[0] as Ring) > 1e-4));
  }
  return polygons;
}
const polygons = europePolygons(TOLERANCE_DEG);
const presetPolygons = europePolygons(PRESET_TOLERANCE_DEG);
const header =
  'Natural Earth 1:50m countries of Europe and Cyprus (public domain, https://www.naturalearthdata.com), clipped to ' +
  'Europe and simplified to ' +
  `${TOLERANCE_DEG}° by scripts/europe-land.ts.`;
writeFileSync(
  'packages/tools/configs/regions/europe-land.geojson',
  `${JSON.stringify({ type: 'Feature', properties: { source: header }, geometry: { type: 'MultiPolygon', coordinates: polygons } })}\n`,
);
writeFileSync(
  'packages/presets/src/europe-land.ts',
  `// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Generated by scripts/europe-land.ts: do not edit.
import type { PolygonDeg } from '@vibeglobe/core';

/** ${header.replace(`${TOLERANCE_DEG}°`, `${PRESET_TOLERANCE_DEG}°`)} */
export const EUROPE_LAND: readonly PolygonDeg[] = ${JSON.stringify(presetPolygons)};

/** West, south, east, north in degrees of the area the Europe preset covers. */
export const EUROPE_BOUNDS = ${JSON.stringify(EUROPE_BOUNDS)} as const;
`,
);
console.log(`${polygons.length} polygons, ${polygons.flat().reduce((n, r) => n + r.length, 0)} points`);

const fine = process.argv[3];
if (fine) {
  const detailed = JSON.parse(readFileSync(fine, 'utf8')) as Countries;
  const borders: Record<string, Ring[][]> = {};
  for (const feature of detailed.features) {
    const code = feature.properties.ISO_A2_EH ?? '';
    if (!inEurope(feature) || !/^[A-Z]{2}$/.test(code)) continue;
    const polygons = countryPolygons(feature, COUNTRY_TOLERANCE_DEG);
    if (polygons.length > 0) borders[code] = polygons;
  }
  const codes = Object.keys(borders).sort();
  const header = `// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Generated by scripts/europe-land.ts: do not edit.
`;
  mkdirSync('packages/presets/src/countries', { recursive: true });
  for (const code of codes)
    writeFileSync(
      `packages/presets/src/countries/${code.toLowerCase()}.ts`,
      `${header}import type { PolygonDeg } from '@vibeglobe/core';

/** ${code}: Natural Earth 1:10m (public domain), clipped to Europe and simplified to ${COUNTRY_TOLERANCE_DEG}°. */
const polygons: readonly PolygonDeg[] = ${JSON.stringify(borders[code])};
export default polygons;
`,
    );
  writeFileSync(
    'packages/presets/src/countries/index.ts',
    `${header}import type { PolygonDeg } from '@vibeglobe/core';

/**
 * The country borders of Europe by ISO 3166-1 alpha-2 code, each in its own module so that an application loads only
 * the countries it uses: Natural Earth 1:10m countries (public domain, https://www.naturalearthdata.com), clipped to
 * Europe and simplified to ${COUNTRY_TOLERANCE_DEG}° (about 300 m) by scripts/europe-land.ts.
 */
export const COUNTRY_BORDERS: Readonly<Record<string, () => Promise<{ default: readonly PolygonDeg[] }>>> = {
${codes.map((code) => `  ${code}: () => import('./${code.toLowerCase()}.js'),`).join('\n')}
};
`,
  );
  console.log(`${codes.length} countries`);
}
