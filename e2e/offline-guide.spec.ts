// The offline guide's examples run as tests (F317): every `ts` block of docs/guides/offline.md runs in the harness page,
// with the hosts it names served by fixtures. Until the M7 PMTiles and MBTiles adapters reach main, the offline track's
// typed stub stands in for `pmtilesImagery` and `mbtilesImagery` (docs/parallel-tracks.md).
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openHarness, startHarness } from './support/offline.ts';

const GUIDE = readFileSync('docs/guides/offline.md', 'utf8');
const EXAMPLES = [...GUIDE.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');

/** Turns `import { a, b } from '@vibeglobe/x';` into reads of the page's module table. */
function runnable(code: string): string {
  return code.replace(/import \{([^}]+)\} from '(@vibeglobe\/[\w-]+)';/g, "const {$1} = __modules['$2'];");
}

test('the offline guide has a section with an example for every topic, and every example runs (F317)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  for (const heading of [
    '## Network modes',
    '## Loading switches',
    '## Offline setup 1: a server on the local network',
    '## Offline setup 2: everything in the browser',
    '## Building packages',
    '## Storage quotas and persistence',
  ])
    expect(GUIDE).toContain(heading);
  expect(EXAMPLES.length).toBeGreaterThanOrEqual(7);

  await openHarness(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'guide-build' }], view: {} });
  const built = await page.evaluate(() =>
    window.offlineHarness?.buildFixture({
      id: 'rome',
      version: '1',
      sourceId: 'osm',
      pattern: 'patches',
      session: 'guide-package',
      bounds: { westDeg: 12.4, southDeg: 41.82, eastDeg: 12.58, northDeg: 41.97 },
      minLevel: 0,
      maxLevel: 8,
    }),
  );
  if (!built) throw new Error('no fixture package');
  const files = new Map<string, Buffer | string>([
    ['manifest.json', JSON.stringify(built.manifest)],
    [built.path, Buffer.from(built.base64, 'base64')],
  ]);
  await page.route('https://lan.example/packages/rome/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const body = files.get(name);
    if (body === undefined) return route.fulfill({ status: 404 });
    const range = /bytes=(\d+)-(\d+)/.exec(route.request().headers()['range'] ?? '');
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (!range || typeof body === 'string') return route.fulfill({ status: 200, headers, body });
    return route.fulfill({ status: 206, headers, body: body.subarray(Number(range[1]), Number(range[2]) + 1) });
  });
  const dev = new URL(page.url()).origin;
  await page.route('https://tiles.example.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = await route.fetch({ url: `${dev}/fixture-tiles/guide/world/mercator${path}` });
    return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });
  page.on('pageerror', (error) => console.log(`page error: ${error.message}`));

  for (const [index, example] of EXAMPLES.entries()) {
    const outcome = await page.evaluate(async (code) => {
      const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');
      const sources = (await import(/* @vite-ignore */ `${repo}/packages/sources/src/index.ts`)) as Record<
        string,
        unknown
      >;
      const stub = (await import(
        /* @vite-ignore */ `${repo}/packages/offline/src/__fixtures__/archive-adapters.ts`
      )) as {
        createStubAdapters(o: { wasmUrl?: string }): { pmtiles: unknown; mbtiles: unknown };
      };
      const adapters = stub.createStubAdapters({ wasmUrl: `${repo}/node_modules/sql.js/dist/sql-wasm.wasm` });
      const modules = {
        '@vibeglobe/offline': await import(/* @vite-ignore */ `${repo}/packages/offline/src/index.ts`),
        '@vibeglobe/sources': { ...sources, pmtilesImagery: adapters.pmtiles, mbtilesImagery: adapters.mbtiles },
      };
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        ...args: string[]
      ) => (modules: unknown) => Promise<void>;
      try {
        await new AsyncFunction('__modules', code)(modules);
        return 'ok';
      } catch (error) {
        return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    }, runnable(example));
    expect(outcome, `example ${index + 1}:\n${example}`).toBe('ok');
  }
});

test('the documentation site publishes the offline guide with every section (F317)', async ({ page }) => {
  await page.goto(`http://localhost:${process.env['DOCS_PORT'] ?? 5174}/documents/Offline_packages.html`);
  await expect(page.getByRole('heading', { name: 'Offline packages', level: 1 })).toBeVisible();
  for (const section of [
    'Network modes',
    'Loading switches',
    'Offline setup 1: a server on the local network',
    'Offline setup 2: everything in the browser',
    'Building packages',
    'Storage quotas and persistence',
  ])
    await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
});
