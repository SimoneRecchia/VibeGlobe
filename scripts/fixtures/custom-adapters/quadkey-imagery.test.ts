import { failures, runTiledConformance } from '@vibeglobe/sources/conformance';
import { fetchTransport } from '@vibeglobe/sources';
import { expect, it } from 'vitest';
import { quadkey, quadkeyImagery } from './quadkey-imagery.ts';

it('a custom adapter package runs the shared conformance suite unchanged (F223)', async () => {
  expect(quadkey({ root: 0, level: 3, x: 3, y: 5 })).toBe('213');
  const bytes = new TextEncoder().encode('png');
  const service: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith('/0000.png') ? new Response(null, { status: 404 }) : new Response(bytes.slice()),
    );
  const results = await runTiledConformance({
    name: 'quadkey (custom package)',
    create: (fetchImpl) => quadkeyImagery(fetchTransport(fetchImpl)),
    fixture: service,
    tiles: [{ coord: { root: 0, level: 3, x: 3, y: 5 }, bytes }],
    missing: [{ root: 0, level: 4, x: 0, y: 0 }],
  });
  expect(failures(results)).toEqual([]);
});
