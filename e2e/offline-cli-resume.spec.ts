// The offline package builder CLI (packages/tools, `vibeglobe-data pack`) resumes a build killed halfway without
// downloading completed tiles again, and writes the same package as an uninterrupted build (F308, offline track).
// It runs the built CLI (npm run build) against the playground's fixture tile server.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const BIN = 'packages/tools/dist/bin.js';
const BBOX = '12.40,41.82,12.58,41.97';

function packArgs(session: string, out: string): string[] {
  return [
    BIN,
    'pack',
    '--source',
    `http://localhost:${process.env['PLAYGROUND_PORT'] ?? 5173}/fixture-tiles/${session}/world/mercator/{z}/{x}/{y}.png`,
    '--profile',
    'fixture',
    '--bbox',
    BBOX,
    '--zooms',
    '0-13',
    '--out',
    out,
    '--yes',
  ];
}

interface Logged {
  readonly path: string;
  readonly status: number;
}

test('a killed package build resumes without downloading completed tiles and writes an identical package (F308)', async ({
  request,
}) => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), 'vibeglobe-pack-'));
  const session = `cli-resume-${Date.now()}`;
  const run = async (args: string[]): Promise<{ code: unknown; output: string }> => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    return { code: await new Promise((resolve) => child.once('exit', resolve)), output };
  };
  const requests = async (id: string): Promise<string[]> =>
    ((await (await request.get(`/_fixture/${id}/log`)).json()) as Logged[]).map((entry) => entry.path.replace(id, ''));
  const counts = (paths: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const path of paths) map.set(path, (map.get(path) ?? 0) + 1);
    return map;
  };
  try {
    // An uninterrupted build: each tile is downloaded once (and some are probed with HEAD for the estimate).
    const clean = join(dir, 'clean.pmtiles');
    expect((await run(packArgs(session, clean))).code).toBe(0);
    const cleanCounts = counts(await requests(session));
    // The same session again (the package records its source URL), with an empty log.
    await request.delete(`/_fixture/${session}`);
    const probed = new Set([...cleanCounts].filter(([, n]) => n > 1).map(([path]) => path));

    // Every tile answers after 100 ms, so the build is still downloading when it is killed.
    await request.post(`/_fixture/${session}/rules`, { data: [{ latencyMs: 100 }] });
    const out = join(dir, 'rome.pmtiles');
    const first = spawn(process.execPath, packArgs(session, out), { stdio: 'ignore' });
    await expect
      .poll(async () => (await requests(session)).length, { timeout: 60_000, intervals: [50] })
      .toBeGreaterThan(40);
    first.kill('SIGKILL');
    await new Promise((resolve) => first.once('exit', resolve));
    const killedAfter = (await requests(session)).length;
    const resumed = await run(packArgs(session, out));
    expect(resumed.code).toBe(0);
    expect(resumed.output).toMatch(/[1-9]\d* already present \(verified\)/);
    // Beyond what a clean build asks for, a resumed one repeats only the estimate's probes and the downloads that were
    // in flight when the process died (at most its concurrency); no completed tile is downloaded again.
    const total = counts(await requests(session));
    const extra = [...total].filter(([path, n]) => n > (cleanCounts.get(path) ?? 0) + (probed.has(path) ? 1 : 0));
    expect(killedAfter).toBeLessThan([...cleanCounts.values()].reduce((a, b) => a + b, 0));
    expect(extra.length).toBeLessThanOrEqual(8);
    expect(readFileSync(out).equals(readFileSync(clean))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
