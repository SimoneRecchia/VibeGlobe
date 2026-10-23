/**
 * A stand-in for the Map Tiles API's Photorealistic 3D Tiles (F468–F470): `v1/3dtiles/root.json?key=` starts a
 * session and answers a root whose content is a nested tileset with the session in its URI, as Google's does; the
 * nested tileset and every tile need the key and a live session, else 400 (an expired session) or 403 (a wrong key).
 * The tiles are the fixture city's (`apps/playground/public/tiles3d/city-plain/`), their glTF copyright rewritten to
 * two data providers, west and east of the city's center line, so the attribution follows the visible tiles.
 * Test code only.
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../../apps/playground/public/tiles3d/city-plain/', import.meta.url);
const FILES = '/v1/3dtiles/datasets/fixture-city/files/';
/** The copyright the fixture city's tiles carry, and its two replacements of the same length (the GLB keeps its size). */
const ORIGINAL = 'VibeGlobe fixture city';
export const WEST_PROVIDER = 'Western Data (c) 2026';
export const EAST_PROVIDER = 'Eastern Data (c) 2026';

/** The mock's state and log. */
export interface Google3DMock {
  readonly fetch: (url: string) => Promise<Response>;
  /** Sessions started, with their start time. */
  readonly sessions: { readonly token: string; readonly startedAtMs: number }[];
  /** Every request and its answer's status. */
  readonly log: { readonly url: string; readonly status: number }[];
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** Replaces the copyright in a tile's bytes with the provider of its side of the city. */
function withProvider(bytes: Buffer, path: string): Buffer {
  const match = /tiles\/(\d)\/(\d+)\/\d+\./.exec(path);
  if (!match) return bytes;
  // The tile's x within its level: west half or east half (the root tile spans both: the western provider).
  const level = Number(match[1]);
  const east = level > 0 && Number(match[2]) >= 2 ** level / 2;
  const provider = (east ? EAST_PROVIDER : WEST_PROVIDER).padEnd(ORIGINAL.length, ' ');
  const at = bytes.indexOf(ORIGINAL);
  if (at < 0) return bytes;
  const out = Buffer.from(bytes);
  out.write(provider, at, 'latin1');
  return out;
}

/** A mock whose sessions expire `sessionLifetimeMs` after they start, answering with the key `key`. */
export function google3dMock(key: string, sessionLifetimeMs = 3 * 60 * 60 * 1000): Google3DMock {
  const sessions: Google3DMock['sessions'] = [];
  const log: Google3DMock['log'] = [];
  const answer = (url: string, response: Response): Response => {
    log.push({ url, status: response.status });
    return response;
  };
  const city = JSON.parse(readFileSync(new URL('tileset.json', ROOT), 'utf8')) as Record<string, unknown>;
  const cityRoot = city['root'] as Record<string, unknown>;
  return {
    sessions,
    log,
    async fetch(url: string) {
      const parsed = new URL(url);
      if (parsed.searchParams.get('key') !== key) return answer(url, json({ error: { code: 403 } }, 403));
      if (parsed.pathname === '/v1/3dtiles/root.json') {
        const token = `mock-session-${sessions.length + 1}`;
        sessions.push({ token, startedAtMs: Date.now() });
        return answer(
          url,
          json({
            asset: { version: '1.0' },
            geometricError: 1e5,
            root: {
              boundingVolume: { sphere: [0, 0, 0, 7e6] },
              geometricError: 1e5,
              refine: 'REPLACE',
              children: [{ ...cityRoot, children: undefined, content: { uri: `${FILES}city.json?session=${token}` } }],
            },
          }),
        );
      }
      const session = sessions.find((s) => s.token === parsed.searchParams.get('session'));
      if (!session || Date.now() - session.startedAtMs > sessionLifetimeMs)
        return answer(url, json({ error: { code: 400, message: 'Session expired' } }, 400));
      if (!parsed.pathname.startsWith(FILES)) return answer(url, new Response(null, { status: 404 }));
      const path = parsed.pathname.slice(FILES.length);
      if (path === 'city.json') return answer(url, json({ ...city, root: { ...cityRoot, transform: undefined } }));
      try {
        return answer(url, new Response(new Uint8Array(withProvider(readFileSync(new URL(path, ROOT)), path))));
      } catch {
        return answer(url, new Response(null, { status: 404 }));
      }
    },
  };
}
