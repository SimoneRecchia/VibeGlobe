// Fixture imagery in UTM zones 32N and 33N (EPSG:32632, EPSG:32633) for client-side reprojection (F226, F227): a
// WMS 1.3.0-style GetMap answer rendering the `world` color field of each pixel's WGS84 position, with magenta ground
// control markers centred on every whole degree of longitude and latitude. The transverse Mercator projection is
// Krüger's series to sixth order in n (C. F. F. Karney, "Transverse Mercator with an accuracy of a few nanometers",
// 2011), written here from the published formulas.
import { PNG } from 'pngjs';
import { worldColor } from './generate.ts';

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING_M = 500000;
const N = F / (2 - F);
const E = Math.sqrt(F * (2 - F));
const RECTIFYING_RADIUS_M = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64 + N ** 6 / 256);
const ALPHA = [
  N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180 - (127 * N ** 5) / 288 + (7891 * N ** 6) / 37800,
  (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440 + (281 * N ** 5) / 630 - (1983433 * N ** 6) / 1935360,
  (61 * N ** 3) / 240 - (103 * N ** 4) / 140 + (15061 * N ** 5) / 26880 + (167603 * N ** 6) / 181440,
  (49561 * N ** 4) / 161280 - (179 * N ** 5) / 168 + (6601661 * N ** 6) / 7257600,
  (34729 * N ** 5) / 80640 - (3418889 * N ** 6) / 1995840,
  (212378941 * N ** 6) / 319334400,
];
const BETA = [
  N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360 - (81 * N ** 5) / 512 + (96199 * N ** 6) / 604800,
  N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440 + (46 * N ** 5) / 105 - (1118711 * N ** 6) / 3870720,
  (17 * N ** 3) / 480 - (37 * N ** 4) / 840 - (209 * N ** 5) / 4480 + (5569 * N ** 6) / 90720,
  (4397 * N ** 4) / 161280 - (11 * N ** 5) / 504 - (830251 * N ** 6) / 7257600,
  (4583 * N ** 5) / 161280 - (108847 * N ** 6) / 3991680,
  (20648693 * N ** 6) / 638668800,
];
const DEG = Math.PI / 180;

/** The central meridian of a UTM zone, degrees. */
function centralMeridianDeg(zone: number): number {
  return zone * 6 - 183;
}

/** WGS84 longitude and latitude (degrees) to UTM easting and northing (meters) of a northern zone. */
export function utmForward(lonDeg: number, latDeg: number, zone: number): [eastingM: number, northingM: number] {
  const phi = latDeg * DEG;
  const lambda = (lonDeg - centralMeridianDeg(zone)) * DEG;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - E * Math.atanh(E * Math.sin(phi)));
  const xiP = Math.atan2(t, Math.cos(lambda));
  const etaP = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let xi = xiP;
  let eta = etaP;
  ALPHA.forEach((alpha, k) => {
    const j = 2 * (k + 1);
    xi += alpha * Math.sin(j * xiP) * Math.cosh(j * etaP);
    eta += alpha * Math.cos(j * xiP) * Math.sinh(j * etaP);
  });
  return [FALSE_EASTING_M + K0 * RECTIFYING_RADIUS_M * eta, K0 * RECTIFYING_RADIUS_M * xi];
}

/** UTM easting and northing (meters) of a northern zone to WGS84 longitude and latitude (degrees). */
export function utmInverse(eastingM: number, northingM: number, zone: number): [lonDeg: number, latDeg: number] {
  const xi = northingM / (K0 * RECTIFYING_RADIUS_M);
  const eta = (eastingM - FALSE_EASTING_M) / (K0 * RECTIFYING_RADIUS_M);
  let xiP = xi;
  let etaP = eta;
  BETA.forEach((beta, k) => {
    const j = 2 * (k + 1);
    xiP -= beta * Math.sin(j * xi) * Math.cosh(j * eta);
    etaP -= beta * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const lambda = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  // The conformal latitude's tangent, then Newton's method for the geodetic latitude's tangent.
  const tauP = Math.sin(xiP) / Math.sqrt(Math.sinh(etaP) ** 2 + Math.cos(xiP) ** 2);
  let tau = tauP;
  for (let i = 0; i < 6; i++) {
    const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
    const tauI = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    tau +=
      ((tauP - tauI) / Math.sqrt(1 + tauI * tauI)) *
      ((1 + (1 - E * E) * tau * tau) / ((1 - E * E) * Math.sqrt(1 + tau * tau)));
  }
  return [centralMeridianDeg(zone) + lambda / DEG, Math.atan(tau) / DEG];
}

/** One GetMap request of the fixture. */
export interface UtmImageRequest {
  /** 32 or 33 (northern zones). */
  zone: number;
  /** minx, miny, maxx, maxy in meters (easting first, as WMS 1.3.0 writes projected systems). */
  bbox: [number, number, number, number];
  widthPx: number;
  heightPx: number;
}

/** The marker color and size: pure magenta squares of 9 × 9 pixels. */
export const MARKER_RGB: readonly [number, number, number] = [255, 0, 255];
export const MARKER_SIZE_PX = 9;
const MAX_SIZE_PX = 4096;

/** Parses WMS 1.3.0 query parameters (names in any case); undefined when they are missing or unsupported. */
export function parseUtmRequest(query: URLSearchParams): UtmImageRequest | undefined {
  const get = (name: string): string | undefined =>
    [...query.entries()].find(([key]) => key.toUpperCase() === name)?.[1];
  const zone = /^EPSG:326(32|33)$/i.exec(get('CRS') ?? '')?.[1];
  const bbox = (get('BBOX') ?? '').split(',').map(Number);
  const widthPx = Number(get('WIDTH'));
  const heightPx = Number(get('HEIGHT'));
  const [minX = NaN, minY = NaN, maxX = NaN, maxY = NaN] = bbox;
  const valid =
    zone !== undefined &&
    bbox.length === 4 &&
    [minX, minY, maxX, maxY].every(Number.isFinite) &&
    minX < maxX &&
    minY < maxY &&
    [widthPx, heightPx].every((v) => Number.isInteger(v) && v >= 1 && v <= MAX_SIZE_PX);
  return valid ? { zone: Number(zone), bbox: [minX, minY, maxX, maxY], widthPx, heightPx } : undefined;
}

/** Renders the request's RGBA pixels, rows from the north: the `world` colors and the degree markers on top. */
export function renderUtmImage(request: UtmImageRequest): Uint8Array {
  const { zone, widthPx: w, heightPx: h } = request;
  const [minX, minY, maxX, maxY] = request.bbox;
  const rgba = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = minX + ((i + 0.5) / w) * (maxX - minX);
      const y = maxY - ((j + 0.5) / h) * (maxY - minY);
      const [lon, lat] = utmInverse(x, y, zone);
      rgba.set([...worldColor(lon * DEG, lat * DEG), 255], (j * w + i) * 4);
    }
  }
  // The degree range of the box, from points along its edges.
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k <= 32; k++) {
    const t = k / 32;
    for (const [x, y] of [
      [minX + (maxX - minX) * t, minY],
      [minX + (maxX - minX) * t, maxY],
      [minX, minY + (maxY - minY) * t],
      [maxX, minY + (maxY - minY) * t],
    ] as const) {
      const [lon, lat] = utmInverse(x, y, zone);
      [west, south, east, north] = [
        Math.min(west, lon),
        Math.min(south, lat),
        Math.max(east, lon),
        Math.max(north, lat),
      ];
    }
  }
  for (let lon = Math.ceil(west); lon <= Math.floor(east); lon++) {
    for (let lat = Math.ceil(south); lat <= Math.floor(north); lat++) {
      const [x, y] = utmForward(lon, lat, zone);
      const px = ((x - minX) / (maxX - minX)) * w;
      const py = ((maxY - y) / (maxY - minY)) * h;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      // Pixels whose centres lie within half the marker of the crossing: their centroid is within half a pixel of it.
      const i0 = Math.round(px - MARKER_SIZE_PX / 2);
      const j0 = Math.round(py - MARKER_SIZE_PX / 2);
      for (let j = Math.max(0, j0); j < Math.min(h, j0 + MARKER_SIZE_PX); j++)
        for (let i = Math.max(0, i0); i < Math.min(w, i0 + MARKER_SIZE_PX); i++)
          rgba.set([...MARKER_RGB, 255], (j * w + i) * 4);
    }
  }
  return rgba;
}

/** Encodes the request's image as PNG. */
export function encodeUtmPng(request: UtmImageRequest): Buffer {
  const png = new PNG({ width: request.widthPx, height: request.heightPx });
  png.data = Buffer.from(renderUtmImage(request));
  return PNG.sync.write(png);
}
