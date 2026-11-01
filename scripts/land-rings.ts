// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Ring helpers of the land mask scripts (`europe-land.ts`, `world-land.ts`). */
export type Point = [number, number];
export type Ring = Point[];

export const round = (v: number): number => Math.round(v * 1e3) / 1e3;

/** Douglas–Peucker simplification of an open polyline. */
export function simplify(points: Ring, tolerance: number): Ring {
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

export function area(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i] as Point;
    const [x1, y1] = ring[(i + 1) % ring.length] as Point;
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}
