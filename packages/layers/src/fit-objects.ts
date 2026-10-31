// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { CameraMovement, GeoBounds, GeoPosition, Globe, MovementOptions } from '@vibeglobe/core';
import type { Feature } from './geojson.js';

/** What {@link fitObjects} frames: features (their every vertex, at its altitude) and positions (models, points). */
export type FitObject = Feature | GeoPosition;

const isPosition = (object: FitObject): object is GeoPosition => 'longitudeDeg' in object;

const DEG = 180 / Math.PI;
/** Web Mercator y of a latitude, unitless. */
const mercatorOf = (latitudeDeg: number): number => Math.asinh(Math.tan(latitudeDeg / DEG));

/** Every coordinate of a geometry, as [longitude, latitude, height]. */
function coordinatesOf(value: unknown, out: number[][]): void {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === 'number') {
    out.push(value as number[]);
    return;
  }
  for (const item of value) coordinatesOf(item, out);
}

/**
 * The bounds of objects and their vertices at their heights (F387): a feature contributes every vertex, at its altitude
 * (the third coordinate) or its extrusion top (`height` or `fill-extrusion-height` property, when given); a position,
 * its point at its height. Undefined for nothing to frame.
 */
export function extentOf(objects: readonly FitObject[]): { bounds: GeoBounds; vertices: GeoPosition[] } | undefined {
  const points: number[][] = [];
  for (const object of objects) {
    if (isPosition(object)) {
      points.push([object.longitudeDeg, object.latitudeDeg, object.heightMeters ?? 0]);
      continue;
    }
    const vertices: number[][] = [];
    const geometry = object.geometry as { coordinates?: unknown; geometries?: { coordinates?: unknown }[] } | null;
    coordinatesOf(geometry?.coordinates, vertices);
    for (const part of geometry?.geometries ?? []) coordinatesOf(part.coordinates, vertices);
    const properties = object.properties ?? {};
    const top = Number(properties['fill-extrusion-height'] ?? properties['height'] ?? 0);
    for (const [lon = 0, lat = 0, height = 0] of vertices) points.push([lon, lat, Math.max(height, top || 0)]);
  }
  if (points.length === 0) return undefined;
  const lons = points.map((p) => p[0] ?? 0);
  const lats = points.map((p) => p[1] ?? 0);
  const bounds = {
    westDeg: Math.min(...lons),
    southDeg: Math.min(...lats),
    eastDeg: Math.max(...lons),
    northDeg: Math.max(...lats),
  };
  const vertices = points.map(([longitudeDeg = 0, latitudeDeg = 0, heightMeters = 0]) => ({
    longitudeDeg,
    latitudeDeg,
    heightMeters,
  }));
  return { bounds, vertices };
}

/**
 * Flies (or eases) to the view that frames every object, heights included, inside the viewport minus `paddingPx`
 * (F387): `Globe.fitBounds` centered on their bounds, with every vertex required to show. Whole models come from
 * `ModelSetLayer.framePositions` (a turbine with its rotor, a plant's every device, F667); `tiltDeg` frames from that
 * tilt instead of the view mode's.
 */
export function fitObjects(
  globe: Pick<Globe, 'fitBounds'>,
  objects: readonly FitObject[],
  options: MovementOptions & {
    readonly paddingPx?: number;
    readonly movement?: 'fly' | 'ease';
    readonly tiltDeg?: number;
  } = {},
): CameraMovement {
  const extent = extentOf(objects);
  if (!extent) throw new RangeError('fitObjects needs at least one object with coordinates');
  // The view centers on the bounds' middle and fits the vertices themselves: in a tilted view the corners of the
  // bounds would project beyond them and frame wider than needed.
  const { westDeg, southDeg, eastDeg, northDeg } = extent.bounds;
  const middle = Math.atan(Math.sinh((mercatorOf(southDeg) + mercatorOf(northDeg)) / 2)) * DEG;
  const center = {
    westDeg: (westDeg + eastDeg) / 2,
    eastDeg: (westDeg + eastDeg) / 2,
    southDeg: middle,
    northDeg: middle,
  };
  return globe.fitBounds(center, { ...options, include: extent.vertices });
}
