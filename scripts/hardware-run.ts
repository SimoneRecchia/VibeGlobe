// Runs the GPU-dependent checks on a machine with a real GPU (docs/guides/hardware-testing.md, F075): the end-to-end
// tests of both backends, the scenario benchmarks and the OffscreenCanvas measurement (ADR 0019), all on the machine's
// GPU. Everything lands in benchmarks/results/<device>/hardware-<date>/ with the device, OS, CPU, browser and GPU.
// Usage: npm run test:hardware -- --device <name> [--browsers chromium,msedge,firefox,webkit] [--software]
// (--software runs the same procedure on the software GPU, to check the procedure itself on a GPU-less machine.)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from './workspace.ts';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const device = option('--device') ?? process.env['VIBEGLOBE_DEVICE'];
if (!device || !/^[a-z0-9][a-z0-9-]*$/.test(device)) {
  console.error('Name the device: npm run test:hardware -- --device <lowercase-name-with-dashes>');
  process.exit(2);
}
const software = process.argv.includes('--software');
const browsers = (option('--browsers') ?? 'chromium').split(',');
const date = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(ROOT_DIR, 'benchmarks/results', device, `hardware-${date}`);
mkdirSync(outDir, { recursive: true });
const env = {
  ...process.env,
  VIBEGLOBE_DEVICE: device,
  ...(software ? {} : { VIBEGLOBE_HARDWARE_GPU: '1' }),
};

/** Runs a step, saving its output; returns whether it succeeded. */
function step(name: string, command: string, args: string[], extraEnv: Record<string, string> = {}): boolean {
  console.log(`\n== ${name}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(join(outDir, `${name}.log`), `${result.stdout}\n${result.stderr}`);
  console.log(result.status === 0 ? 'passed' : `FAILED (exit ${String(result.status)}), see ${name}.log`);
  return result.status === 0;
}

const outcomes: Record<string, boolean> = {};
outcomes['build'] = step('build', 'npm', ['run', 'build']);
outcomes['e2e'] = step(
  'e2e',
  'npx',
  [
    'playwright',
    'test',
    'e2e/visual.spec.ts',
    'e2e/globe-core.spec.ts',
    'e2e/globe-precision.spec.ts',
    'e2e/globe-gpu-probes.spec.ts',
    'e2e/terrain-camera.spec.ts',
    '--reporter=line,json',
  ],
  { PLAYWRIGHT_JSON_OUTPUT_NAME: join(outDir, 'e2e.json') },
);
// Timing budgets are meaningful only on a real GPU.
outcomes['bench'] = step('bench', 'npm', ['run', 'bench', ...(software ? ['--', '--report-only'] : [])]);
outcomes['bench-micro'] = step('bench-micro', 'npm', ['run', 'bench:micro']);
for (const browser of browsers) {
  const selector = ['chrome', 'msedge'].includes(browser) ? ['--channel', browser] : ['--browser', browser];
  outcomes[`offscreen-${browser}`] = step(`offscreen-${browser}`, 'npm', [
    'run',
    'bench:offscreen',
    '--',
    ...selector,
    ...(software ? [] : ['--hardware']),
  ]);
}

// The benchmark harnesses record the browser and GPU in their reports; the newest ones belong to this run.
const deviceDir = join(ROOT_DIR, 'benchmarks/results', device);
const reports = readdirSync(deviceDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .slice(-1 - browsers.length);
const gpu = reports
  .map((name) => (JSON.parse(readFileSync(join(deviceDir, name), 'utf8')) as { device?: { gpu?: string } }).device?.gpu)
  .find((value) => value !== undefined && value !== 'hardware');
const summary = {
  device,
  date,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
  os: `${process.platform} ${release()} ${arch()}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  gpu: software ? 'software (SwiftShader)' : (gpu ?? 'see the benchmark reports'),
  browsers,
  reports,
  outcomes,
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nResults: ${outDir}`);
if (Object.values(outcomes).includes(false)) process.exit(1);
