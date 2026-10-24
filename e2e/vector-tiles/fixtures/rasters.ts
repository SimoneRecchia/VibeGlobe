// Raster fixtures of the layer types (F445): a raster tileset whose color varies continuously with longitude and
// latitude, with a graticule every 10 degrees (misplaced or seamed tiles show), and terrarium-encoded DEM tiles of an
// analytic mountain at the fixture terrain's peak, for hillshade. Invented data.
import { PNG } from 'pngjs';

/** Pixels per side of the raster fixture tiles. */
const RASTER_TILE_PX = 256;
/** The deepest zoom of the raster tileset (the whole world at every zoom up to it). */
export const RASTER_MAX_ZOOM = 3;
/** The DEM tiles: zooms and the box they cover (west, south, east, north). */
const DEM_ZOOMS = [9, 10, 11, 12] as const;
const DEM_BOX = [6.75, 45.62, 6.97, 45.78] as const;

function lonLat(z: number, x: number, y: number, px: number, py: number): [number, number] {
  const n = 2 ** z;
  const fx = (x + (px + 0.5) / RASTER_TILE_PX) / n;
  const fy = (y + (py + 0.5) / RASTER_TILE_PX) / n;
  return [fx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * fy))) * 180) / Math.PI];
}

function png(z: number, x: number, y: number, pixel: (lon: number, lat: number) => readonly number[]): Buffer {
  const image = new PNG({ width: RASTER_TILE_PX, height: RASTER_TILE_PX });
  for (let py = 0; py < RASTER_TILE_PX; py++)
    for (let px = 0; px < RASTER_TILE_PX; px++) {
      const [lon, lat] = lonLat(z, x, y, px, py);
      const [r = 0, g = 0, b = 0, a = 255] = pixel(lon, lat);
      image.data.set([r, g, b, a], (py * RASTER_TILE_PX + px) * 4);
    }
  return PNG.sync.write(image);
}

/** A raster tile: red with longitude, green with latitude, dark graticule lines every 10 degrees. */
export function rasterTile(z: number, x: number, y: number): Buffer {
  const lineDeg = (0.6 * 360) / (RASTER_TILE_PX * 2 ** z);
  return png(z, x, y, (lon, lat) => {
    const near = (v: number) => Math.abs(v - Math.round(v / 10) * 10) < lineDeg;
    if (near(lon) || near(lat)) return [40, 40, 60];
    return [Math.round(((lon + 180) / 360) * 255), Math.round(((lat + 90) / 180) * 255), 160];
  });
}

/** Heights of the fixture mountain: a 3000 m peak at (6.86, 45.70) with a ridge to the east. */
function mountainHeightMeters(lon: number, lat: number): number {
  const dx = (lon - 6.86) / 0.035;
  const dy = (lat - 45.7) / 0.025;
  const ridge = Math.exp(-(((lat - 45.7) / 0.01) ** 2) - ((lon - 6.93) / 0.03) ** 2);
  return 800 + 2200 * Math.exp(-(dx * dx + dy * dy) / 2) + 600 * ridge;
}

/** A terrarium DEM tile of the fixture mountain. */
export function demTile(z: number, x: number, y: number): Buffer {
  return png(z, x, y, (lon, lat) => {
    const v = mountainHeightMeters(lon, lat) + 32768;
    return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v % 1) * 256)];
  });
}

/** The DEM tiles over the box, as z/x/y. */
export function demTiles(): { z: number; x: number; y: number }[] {
  const out: { z: number; x: number; y: number }[] = [];
  const [west, south, east, north] = DEM_BOX;
  for (const z of DEM_ZOOMS) {
    const n = 2 ** z;
    const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat: number) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
    };
    for (let x = tx(west); x <= tx(east); x++) for (let y = ty(north); y <= ty(south); y++) out.push({ z, x, y });
  }
  return out;
}
