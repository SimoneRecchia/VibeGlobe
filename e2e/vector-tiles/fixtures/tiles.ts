// Cuts the fixture geography into Mapbox Vector Tiles (ADR 0131): every tile of zooms 0–3, and from zoom 4 to 14
// the tiles over the detail areas only; elsewhere deeper tiles are missing (404) and their ancestors stand in.
import { clipLine, clipRing, signedArea, type TilePoint } from '@vibeglobe/layers/vector-tiles';
import { encodeMvt, type FixtureFeature } from './mvt-encode.ts';
import { allFeatures, DETAIL_AREAS, type GeoFeature } from './data.ts';

/** Tile extent and clip buffer of the fixture tiles. */
const EXTENT = 4096;
const BUFFER = 64;
/** The deepest zoom of the fixture tileset (overzoomed beyond, F442). */
const MAX_ZOOM = 14;
/** Zooms up to this one cover the whole world. */
const WORLD_ZOOM = 3;

function worldXY(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

/** The fixture tiles: keys `z/x/y`. */
export function tileList(): { z: number; x: number; y: number }[] {
  const out: { z: number; x: number; y: number }[] = [];
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const n = 2 ** z;
    const seen = new Set<string>();
    const add = (x: number, y: number) => {
      const key = `${x}/${y}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ z, x, y });
    };
    if (z <= WORLD_ZOOM) {
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) add(x, y);
      continue;
    }
    for (const [west, south, east, north] of DETAIL_AREAS) {
      const [x0, y0] = worldXY(west, north);
      const [x1, y1] = worldXY(east, south);
      for (let x = Math.floor(x0 * n); x <= Math.floor(x1 * n); x++)
        for (let y = Math.floor(y0 * n); y <= Math.floor(y1 * n); y++) add(x, y);
    }
  }
  return out;
}

const RECT = { minX: -BUFFER, minY: -BUFFER, maxX: EXTENT + BUFFER, maxY: EXTENT + BUFFER };

function toTile(z: number, x: number, y: number, [lon, lat]: readonly [number, number]): TilePoint {
  const [wx, wy] = worldXY(lon, lat);
  const n = 2 ** z;
  return [(wx * n - x) * EXTENT, (wy * n - y) * EXTENT];
}

function cut(feature: GeoFeature, z: number, x: number, y: number): FixtureFeature | undefined {
  const parts = feature.coordinates.map((part) => part.map((p) => toTile(z, x, y, p)));
  let geometry: TilePoint[][] = [];
  if (feature.type === 'Point') {
    const p = parts[0]?.[0];
    if (p !== undefined && p[0] >= 0 && p[1] >= 0 && p[0] < EXTENT && p[1] < EXTENT) geometry = [[p]];
  } else if (feature.type === 'LineString') {
    geometry = parts.flatMap((part) => clipLine(part, RECT)).filter((part) => part.length >= 2);
  } else {
    geometry = parts
      .map((ring, i) => {
        const clipped = clipRing(ring, RECT);
        // Exteriors are clockwise on screen (positive area), holes the other way (MVT 2.1).
        const exterior = i === 0;
        if (signedArea(clipped) > 0 !== exterior) clipped.reverse();
        return clipped;
      })
      .filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) > 0.5)
      .map((ring) => [...ring, ring[0] as TilePoint]);
    if (geometry.length === 0 || feature.coordinates.length === 0) return undefined;
  }
  if (geometry.length === 0) return undefined;
  return {
    ...(feature.id === undefined ? {} : { id: feature.id }),
    type: feature.type,
    geometry,
    properties: feature.properties,
  };
}

/** The tile's bytes, or undefined when no feature reaches it. */
export function encodeTile(z: number, x: number, y: number, features = allFeatures()): Uint8Array | undefined {
  const layers: Record<string, FixtureFeature[]> = {};
  for (const feature of features) {
    if (feature.minzoom > z) continue;
    const cutFeature = cut(feature, z, x, y);
    if (cutFeature !== undefined) (layers[feature.layer] ??= []).push(cutFeature);
  }
  if (Object.keys(layers).length === 0) return undefined;
  return encodeMvt(layers, EXTENT);
}
