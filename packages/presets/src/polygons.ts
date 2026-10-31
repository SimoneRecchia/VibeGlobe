// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The text form of the bundled land mask and country borders (KB-297), a quarter of their JSON: polygons split by commas,
 * rings by spaces, and each ring's points as the differences from the previous point in thousandths of a degree,
 * longitude then latitude, written as the polyline algorithm writes them (five bits a character, 63 added, 32 when
 * more follow). Points are kept to the thousandth of a degree, as `scripts/europe-land.ts` rounds them.
 */
import type { PolygonDeg } from '@vibeglobe/core';

/** Writes polygons as text (`scripts/europe-land.ts`). */
export function encodePolygons(polygons: readonly PolygonDeg[]): string {
  const value = (v: number): string => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let out = '';
    for (; n >= 32; n >>= 5) out += String.fromCharCode((32 | (n & 31)) + 63);
    return out + String.fromCharCode(n + 63);
  };
  return polygons
    .map((polygon) =>
      polygon
        .map((ring) => {
          let [x0, y0] = [0, 0];
          return ring
            .map(([lon, lat]) => {
              const [x, y] = [Math.round(lon * 1000), Math.round(lat * 1000)];
              const text = value(x - x0) + value(y - y0);
              [x0, y0] = [x, y];
              return text;
            })
            .join('');
        })
        .join(' '),
    )
    .join(',');
}

/** Reads polygons written by {@link encodePolygons}. */
export function decodePolygons(text: string): PolygonDeg[] {
  return text.split(',').map((polygon) =>
    polygon.split(' ').map((ring) => {
      const points: [number, number][] = [];
      const xy = [0, 0];
      for (let i = 0, n = 0, shift = 0, axis = 0; i < ring.length; i++) {
        const bits = ring.charCodeAt(i) - 63;
        n |= (bits & 31) << shift;
        shift += 5;
        if (bits >= 32) continue;
        xy[axis] = (xy[axis] ?? 0) + (n & 1 ? ~(n >>> 1) : n >>> 1);
        if (axis === 1) points.push([(xy[0] ?? 0) / 1000, (xy[1] ?? 0) / 1000]);
        axis = 1 - axis;
        n = shift = 0;
      }
      return points;
    }),
  );
}
