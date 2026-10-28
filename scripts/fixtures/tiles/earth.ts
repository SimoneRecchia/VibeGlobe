// The `earth` fixture patterns (F636): imagery sampled from the playground's Natural Earth base image, so every source
// of a zoom scenario shows the same ground as the base image, continuous across tiles and levels. `earth` is the
// image's own colors, `earth-package` its land in another tone with the sea in the WorldCover package's flat no-data
// water (a package stand-in), `earth-fine` its own colors again (an online orthophoto stand-in, shown in its own colors:
// F638), `earth-marble` a Blue Marble stand-in, darker and bluer, its sea dark and blotched (KB-234, KB-237).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';

/** The base image the playground pins (`apps/playground/public/imagery`). */
const IMAGE_PATH = fileURLToPath(
  new URL('../../../apps/playground/public/imagery/natural-earth-4096.jpg', import.meta.url),
);

/** The package's no-data water (`WORLDCOVER_WATER_RGB` of `@vibeglobe/presets`). */
export const PACKAGE_WATER_RGB: readonly [number, number, number] = [54, 73, 90];
/** The per-channel tones of the package and fine stand-ins over the base image's colors. */
export const EARTH_TONES: Readonly<Record<string, readonly [number, number, number]>> = {
  earth: [1, 1, 1],
  'earth-package': [0.8, 0.9, 0.75],
  'earth-fine': [1, 1, 1],
  // NASA's Blue Marble as it looks beside Natural Earth: land darker and bluer, the sea far darker.
  'earth-marble': [0.72, 0.78, 0.9],
};

/** The `earth-marble` sea's tone, and the strength of its blotches (the Blue Marble's bathymetry, magnified). */
const MARBLE_SEA: readonly [number, number, number] = [0.35, 0.45, 0.65];
const MARBLE_BLOTCHES = 0.25;

let image: { width: number; height: number; data: Uint8Array } | undefined;

function decoded(): { width: number; height: number; data: Uint8Array } {
  image ??= jpeg.decode(readFileSync(IMAGE_PATH), { useTArray: true });
  return image;
}

/** The base image's color at a position (radians), bilinear. */
export function earthColor(lonRad: number, latRad: number): [number, number, number] {
  const { width, height, data } = decoded();
  const x = ((lonRad + Math.PI) / (2 * Math.PI)) * width - 0.5;
  const y = ((Math.PI / 2 - latRad) / Math.PI) * height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = Math.max(0, Math.min(1, y - y0));
  const at = (px: number, py: number, c: number): number =>
    data[(py * width + (((px % width) + width) % width)) * 4 + c] ?? 0;
  const color: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx;
    const bottom = at(x0, y1, c) * (1 - fx) + at(x0 + 1, y1, c) * fx;
    color[c] = Math.round(top * (1 - fy) + bottom * fy);
  }
  return color;
}

/** True where the base image shows water: its blue well above its red and green. */
export function isWater(color: readonly [number, number, number]): boolean {
  return color[2] - color[0] > 45 && color[2] - color[1] > 15;
}

/** A pixel of an `earth` pattern at a position (radians). */
export function earthPixel(pattern: string, lonRad: number, latRad: number): [number, number, number] {
  const color = earthColor(lonRad, latRad);
  if (pattern === 'earth-package' && isWater(color)) return [...PACKAGE_WATER_RGB];
  if (pattern === 'earth-marble' && isWater(color)) {
    // Dark blotches some tens of kilometers wide, as the Blue Marble's sea floor shows through its water.
    const blotch = 1 - MARBLE_BLOTCHES * (0.5 + 0.5 * Math.sin(lonRad * 900) * Math.sin(latRad * 1100));
    return [0, 1, 2].map((c) => Math.round((color[c] ?? 0) * (MARBLE_SEA[c] ?? 1) * blotch)) as [
      number,
      number,
      number,
    ];
  }
  const tone = EARTH_TONES[pattern] ?? [1, 1, 1];
  return [Math.round(color[0] * tone[0]), Math.round(color[1] * tone[1]), Math.round(color[2] * tone[2])];
}
