// Georeferenced fixture images for the single-image adapter (F234): a smooth color field with
// magenta ground control markers on every multiple of 3° of longitude and latitude, rendered in EPSG:4326,
// EPSG:3857 or EPSG:32632 over a box, as PNG (with a world file) or as a GeoTIFF with its own tags.
import { transformCoordinates } from '@vibeglobe/gis';
import { writeArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';

const DEG = Math.PI / 180;

/** A smooth color field over the globe; green always above red and blue, so nothing reads as a magenta marker. */
function worldColor(lonRad: number, latRad: number): [number, number, number] {
  return [
    Math.round(100 + 60 * Math.sin(2 * lonRad) * Math.cos(latRad)),
    Math.round(200 + 40 * Math.cos(3 * latRad)),
    Math.round(100 + 60 * Math.cos(lonRad + latRad)),
  ];
}

/** The marker spacing, degrees, and size, pixels; its centroid is within half a pixel of the crossing. */
export const MARKER_STEP_DEG = 3;
const MARKER_PX = 9;

/** A fixture image: its system, box (minx, miny, maxx, maxy) and size. */
export interface GeoImageSpec {
  readonly crs: 'EPSG:4326' | 'EPSG:3857' | 'EPSG:32632';
  readonly box: readonly [number, number, number, number];
  readonly widthPx: number;
  readonly heightPx: number;
  /** Draws the ground control markers (default true). */
  readonly markers?: boolean;
}

const toLonLat = (crs: string, x: number, y: number): [number, number] => {
  if (crs === 'EPSG:4326') return [x, y];
  const p = transformCoordinates({ x, y }, crs, 'EPSG:4326');
  return [p.x, p.y];
};
const fromLonLat = (crs: string, lon: number, lat: number): [number, number] => {
  if (crs === 'EPSG:4326') return [lon, lat];
  const p = transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', crs);
  return [p.x, p.y];
};

/** The image's RGBA pixels, rows from the north. */
export function renderGeoImage(spec: GeoImageSpec): Uint8Array {
  const { crs, widthPx: w, heightPx: h } = spec;
  const [minX, minY, maxX, maxY] = spec.box;
  const rgba = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const [lon, lat] = toLonLat(crs, minX + ((i + 0.5) / w) * (maxX - minX), maxY - ((j + 0.5) / h) * (maxY - minY));
      rgba.set([...worldColor(lon * DEG, lat * DEG), 255], (j * w + i) * 4);
    }
  if (spec.markers === false) return rgba;
  const [west, south] = toLonLat(crs, minX, minY);
  const [east, north] = toLonLat(crs, maxX, maxY);
  for (
    let lon = MARKER_STEP_DEG * Math.ceil(Math.min(west, east) / MARKER_STEP_DEG);
    lon <= Math.max(west, east);
    lon += MARKER_STEP_DEG
  )
    for (let lat = MARKER_STEP_DEG * Math.ceil(south / MARKER_STEP_DEG); lat <= north; lat += MARKER_STEP_DEG) {
      const [x, y] = fromLonLat(crs, lon, lat);
      const px = ((x - minX) / (maxX - minX)) * w;
      const py = ((maxY - y) / (maxY - minY)) * h;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      const i0 = Math.round(px - MARKER_PX / 2);
      const j0 = Math.round(py - MARKER_PX / 2);
      for (let j = Math.max(0, j0); j < Math.min(h, j0 + MARKER_PX); j++)
        for (let i = Math.max(0, i0); i < Math.min(w, i0 + MARKER_PX); i++)
          rgba.set([255, 0, 255, 255], (j * w + i) * 4);
    }
  return rgba;
}

/** The image as PNG. */
export function geoImagePng(spec: GeoImageSpec): Uint8Array<ArrayBuffer> {
  const png = new PNG({ width: spec.widthPx, height: spec.heightPx });
  png.data = Buffer.from(renderGeoImage(spec));
  return new Uint8Array(PNG.sync.write(png));
}

/** The world file of the image: pixel sizes and the centre of its top-left pixel. */
export function worldFileOf(spec: GeoImageSpec): string {
  const [minX, minY, maxX, maxY] = spec.box;
  const a = (maxX - minX) / spec.widthPx;
  const e = -(maxY - minY) / spec.heightPx;
  return [a, 0, 0, e, minX + a / 2, maxY + e / 2].map(String).join('\n') + '\n';
}

/** The image as an RGB GeoTIFF placed by ModelTiepoint and ModelPixelScale, its EPSG code in its GeoKeys. */
export function geoImageTiff(spec: GeoImageSpec): ArrayBuffer {
  const rgba = renderGeoImage(spec);
  const rgb = new Uint8Array(spec.widthPx * spec.heightPx * 3);
  for (let p = 0, q = 0; q < rgb.length; p += 4, q += 3) rgb.set(rgba.subarray(p, p + 3), q);
  const [minX, minY, maxX, maxY] = spec.box;
  const code = Number(spec.crs.slice(5));
  const geographic = spec.crs === 'EPSG:4326';
  return writeArrayBuffer(rgb, {
    width: spec.widthPx,
    height: spec.heightPx,
    BitsPerSample: [8, 8, 8],
    PhotometricInterpretation: 2,
    SamplesPerPixel: 3,
    ModelPixelScale: [(maxX - minX) / spec.widthPx, (maxY - minY) / spec.heightPx, 0],
    ModelTiepoint: [0, 0, 0, minX, maxY, 0],
    GTModelTypeGeoKey: geographic ? 2 : 1,
    GTRasterTypeGeoKey: 1,
    ...(geographic ? { GeographicTypeGeoKey: code } : { ProjectedCSTypeGeoKey: code }),
  });
}
