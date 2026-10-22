// A recorded-behavior fixture of the Google Map Tiles API for the Google conformance suite: createSession, 2D tiles,
// viewport copyrights and Street View, with session expiry and quota errors on demand. Request and answer shapes follow
// ADR 0031's reading of the API.

/** What the fixture records and how it is steered. */
export interface GoogleFixture {
  readonly fetch: typeof fetch;
  /** Every request, URL and (for POST) body. */
  readonly requests: { url: string; body?: unknown }[];
  /** Makes every session issued so far invalid (the server answers 401 for them). */
  expireSessions(): void;
  /** From now on every request is refused with a quota error (429, RESOURCE_EXHAUSTED). */
  exhaustQuota(): void;
  /** `Cache-Control` max-age of tiles, seconds (default 300). */
  maxAgeSeconds: number;
}

const KEY = 'fixture-key';

/** The key the fixture accepts. */
export const GOOGLE_FIXTURE_KEY = KEY;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The copyright of a viewport: the fixture has different data providers west and east of 0° longitude. */
export function fixtureCopyright(westDeg: number): string {
  return westDeg < 0 ? 'Map data ©2026 Western Provider' : 'Map data ©2026 Eastern Provider';
}

/** The Street View endpoints: metadata by panorama id or position, and panorama tiles. */
function streetView(url: URL): Response | undefined {
  const path = url.pathname;
  if (path.endsWith('/v1/streetview/metadata')) {
    const panoId = url.searchParams.get('panoId') ?? (url.searchParams.has('lat') ? 'pano-near' : null);
    if (!panoId || panoId === 'missing') return new Response(null, { status: 404 });
    return json({
      panoId,
      lat: 45.8326,
      lng: 6.8652,
      imageWidth: 16384,
      imageHeight: 8192,
      tileWidth: 512,
      tileHeight: 512,
      heading: 90,
      date: '2024-07',
      copyright: '© 2024 Google',
    });
  }
  const pano = /\/v1\/streetview\/tiles\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
  if (pano && url.searchParams.get('panoId'))
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } });
  return undefined;
}

/** A fixture Map Tiles API at `base` (default `https://tile.googleapis.com/`). */
export function googleFixture(
  tileBytes: (z: number, x: number, y: number) => Uint8Array,
  base = 'https://tile.googleapis.com/',
): GoogleFixture {
  const requests: { url: string; body?: unknown }[] = [];
  const valid = new Set<string>();
  let issued = 0;
  let quota = false;
  const fixture: GoogleFixture = {
    requests,
    maxAgeSeconds: 300,
    expireSessions: () => valid.clear(),
    exhaustQuota: () => (quota = true),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push(body === undefined ? { url: url.href } : { url: url.href, body });
      if (!url.href.startsWith(base)) return new Response(null, { status: 404 });
      if (quota) return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, 429);
      if (url.searchParams.get('key') !== KEY) return json({ error: { code: 403, message: 'API key not valid' } }, 403);
      const path = url.pathname;
      if (path.endsWith('/v1/createSession') && init?.method === 'POST') {
        const session = `session-${++issued}`;
        valid.add(session);
        return json({
          session,
          expiry: String(Math.floor(Date.now() / 1000) + 14 * 86400),
          tileWidth: 256,
          tileHeight: 256,
          imageFormat: 'png',
        });
      }
      if (!valid.has(url.searchParams.get('session') ?? ''))
        return json({ error: { code: 401, message: 'Invalid session' } }, 401);
      const tile = /\/v1\/2dtiles\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
      if (tile) {
        const [z, x, y] = tile.slice(1).map(Number) as [number, number, number];
        if (z > 18) return new Response(null, { status: 404 });
        return new Response(tileBytes(z, x, y).slice(), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': `private, max-age=${fixture.maxAgeSeconds}` },
        });
      }
      if (path.endsWith('/tile/v1/viewport'))
        return json({ copyright: fixtureCopyright(Number(url.searchParams.get('west'))), maxZoomRects: [] });
      return streetView(url) ?? new Response(null, { status: 404 });
    },
  };
  return fixture;
}
