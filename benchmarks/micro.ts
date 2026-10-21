// Micro-benchmarks of per-frame engine code, on the built packages (npm run build first). ADR 0004: updating the split
// offsets of 5,000 draws takes at most 0.1 ms per frame on the reference desktop (budgets.json, micro). Results go to
// benchmarks/results/<device>/micro-<date>.json; --report-only records without failing (CI's shared runners).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../scripts/workspace.ts';
import { median, percentile } from './budgets.ts';

/** The part of a three.js Object3D the offset code writes: its world matrix's elements, a plain array of 16 numbers. */
interface Placed {
  matrixWorld: { elements: number[] };
}

const { placeEyeRelative } = (await import(join(ROOT_DIR, 'packages/renderer/dist/eye-relative.js'))) as {
  placeEyeRelative(mesh: Placed, origin: Float64Array, eye: Float64Array): void;
};

const DRAWS = 5000;
const FRAMES = 2000;

function eyeRelative5000(): number[] {
  const meshes: Placed[] = Array.from({ length: DRAWS }, () => ({
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  }));
  const origins = meshes.map((_, i) => Float64Array.of(4e6 + i * 37.1, 3e6 - i * 11.3, 3.9e6 + i * 5.7));
  const eye = Float64Array.of(4e6, 3e6, 3.9e6);
  const times: number[] = [];
  for (let n = 0; n < FRAMES * 2; n++) {
    eye[0] = 4e6 + n * 0.013;
    const start = performance.now();
    for (let i = 0; i < DRAWS; i++) placeEyeRelative(meshes[i] as Placed, origins[i] as Float64Array, eye);
    // The first half warms the optimizing compiler up.
    if (n >= FRAMES) times.push(performance.now() - start);
  }
  return times;
}

const budgets =
  (
    JSON.parse(readFileSync(join(ROOT_DIR, 'quality/budgets.json'), 'utf8')) as {
      micro?: Record<string, { medianMs: number }>;
    }
  ).micro ?? {};
const times = eyeRelative5000();
const results = { 'eye-relative-5000-draws': { medianMs: median(times), p95Ms: percentile(times, 0.95) } };
const violations = Object.entries(results).flatMap(([name, result]) => {
  const budget = budgets[name];
  return budget && result.medianMs > budget.medianMs
    ? [`${name}: median ${result.medianMs.toFixed(4)} ms > ${budget.medianMs} ms`]
    : [];
});
const device = process.env['VIBEGLOBE_DEVICE'] ?? 'local';
const date = new Date().toISOString();
const outDir = join(ROOT_DIR, 'benchmarks/results', device);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `micro-${date.replace(/[:.]/g, '-')}.json`);
const report = {
  schemaVersion: 1,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
  date,
  device: { name: device, os: `${process.platform} ${release()}`, cpu: cpus()[0]?.model, node: process.version },
  results,
  violations,
};
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
for (const [name, result] of Object.entries(results))
  console.log(`${name.padEnd(26)} median ${result.medianMs.toFixed(4)} ms · p95 ${result.p95Ms.toFixed(4)} ms`);
for (const violation of violations) console.error(`BUDGET  ${violation}`);
console.log(`Results: ${outFile}`);
if (violations.length > 0 && !process.argv.includes('--report-only')) process.exit(1);
