// Checks the geodesic solvers against Karney's GeodTest data set (F076): distances within 0.1 mm, azimuths within
// 1e-9° where the problem is well conditioned. The data set states no license, so it is downloaded here instead of
// being committed. Needs `npm run build`. `--file <path>` reads a local copy (plain or gzip).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { geodesicDirect, geodesicInverse } from '@vibeglobe/core/geodesy';

const URL_SHORT = 'https://sourceforge.net/projects/geographiclib/files/testdata/GeodTest-short.dat.gz/download';
const DISTANCE_TOLERANCE_METERS = 1e-4;
const AZIMUTH_TOLERANCE_DEG = 1e-9;
/**
 * Where the azimuth is ill-conditioned (short lines, conjugate points) the criterion becomes its effect on the far end
 * point, |m12|·δα under 10 nm: rounding the reference end points to doubles already moves them by about 1.6 nm, and
 * GeographicLib's own errors on these rows match ours (see packages/core/src/geodesy/geodesic-dataset.test.ts).
 */
const END_POINT_TOLERANCE_METERS = 1e-8;
/** GeodTest's categories in file order with their share of the lines (the random block is twice the others). */
const BLOCKS: readonly [string, number][] = [
  ['random', 0.2],
  ['nearly antipodal', 0.1],
  ['short (< 1 km)', 0.1],
  ['one end near a pole', 0.1],
  ['both ends near opposite poles', 0.1],
  ['nearly meridional', 0.1],
  ['nearly equatorial', 0.1],
  ['between vertices', 0.1],
  ['ending near vertices', 0.1],
];

function blockOf(fraction: number): string {
  let end = 0;
  for (const [name, share] of BLOCKS) {
    end += share;
    if (fraction < end - 1e-12) return name;
  }
  return BLOCKS.at(-1)?.[0] ?? 'unknown';
}

async function load(): Promise<string> {
  const fileIndex = process.argv.indexOf('--file');
  const bytes =
    fileIndex === -1
      ? Buffer.from(await (await fetch(URL_SHORT, { redirect: 'follow' })).arrayBuffer())
      : readFileSync(process.argv[fileIndex + 1] as string);
  return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
}

function wrapDeg(angleDeg: number): number {
  const reduced = angleDeg % 360;
  if (reduced > 180) return reduced - 360;
  return reduced < -180 ? reduced + 360 : reduced;
}

const lines = (await load()).split('\n').filter((line) => line.trim() !== '');
if (lines.length < 1000) throw new Error(`GeodTest: expected at least 1000 lines, got ${lines.length}`);
const maxima = new Map<string, { distance: number; azimuth: number }>();
let failures = 0;
lines.forEach((line, index) => {
  const [lat1 = NaN, lon1 = NaN, azi1 = NaN, lat2 = NaN, lon2 = NaN, azi2 = NaN, s12 = NaN, , m12 = NaN] = line
    .split(' ')
    .map(Number);
  const inverse = geodesicInverse(lon1, lat1, lon2, lat2);
  const direct = geodesicDirect(lon1, lat1, azi1, s12);
  const distanceError = Math.abs(inverse.distanceMeters - s12);
  // The direct end point's error, converted to meters, also bounds the inverse azimuths' consistency.
  const directError = Math.hypot(
    (direct.latitudeDeg - lat2) * 111320,
    wrapDeg(direct.longitudeDeg - lon2) * 111320 * Math.cos((lat2 * Math.PI) / 180),
  );
  const azimuthError = Math.max(
    Math.abs(wrapDeg(inverse.initialAzimuthDeg - azi1)),
    Math.abs(wrapDeg(inverse.finalAzimuthDeg - azi2)),
  );
  const azimuthOk =
    azimuthError <= AZIMUTH_TOLERANCE_DEG ||
    ((azimuthError * Math.PI) / 180) * Math.abs(m12) <= END_POINT_TOLERANCE_METERS;
  const block = blockOf(index / lines.length);
  const max = maxima.get(block) ?? { distance: 0, azimuth: 0 };
  max.distance = Math.max(max.distance, distanceError, directError);
  max.azimuth = Math.max(max.azimuth, azimuthError);
  maxima.set(block, max);
  if (distanceError > DISTANCE_TOLERANCE_METERS || directError > DISTANCE_TOLERANCE_METERS || !azimuthOk) {
    failures++;
    if (failures <= 10)
      console.error(
        `line ${index + 1}: distance ${distanceError} m, direct ${directError} m, azimuth ${azimuthError}°`,
      );
  }
});
for (const [block, max] of maxima) {
  console.log(
    `${block.padEnd(30)} max distance error ${max.distance.toExponential(2)} m, max azimuth error ${max.azimuth.toExponential(2)}°`,
  );
}
if (failures > 0) {
  console.error(`GeodTest: ${failures} of ${lines.length} geodesics outside the tolerances`);
  process.exit(1);
}
console.log(
  `GeodTest: all ${lines.length} geodesics within 0.1 mm and 1e-9° (or 10 nm at the far end where ill-conditioned)`,
);
