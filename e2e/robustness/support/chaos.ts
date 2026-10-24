// The fault injector of the chaos scenarios (F510): every matching response, while the injector is on, randomly
// passes, fails (reset, disconnected, HTTP 500), arrives late, arrives truncated or arrives with corrupted bytes.
import type { Page, Route } from '@playwright/test';

export type Fault = 'pass' | 'reset' | 'disconnected' | 'error-500' | 'slow' | 'truncated' | 'corrupted';

/** Shares of each fault among the requests (the rest pass). */
const FAULTS: readonly [Fault, number][] = [
  ['reset', 0.1],
  ['disconnected', 0.05],
  ['error-500', 0.1],
  ['slow', 0.15],
  ['truncated', 0.1],
  ['corrupted', 0.1],
];

/** A running injector: switch it off to let every request pass, and read what it did. */
export interface Chaos {
  enabled: boolean;
  readonly counts: Record<Fault, number>;
}

function pick(random: () => number): Fault {
  let roll = random();
  for (const [fault, share] of FAULTS) {
    if (roll < share) return fault;
    roll -= share;
  }
  return 'pass';
}

/** Answers a route with `fault`, fetching the real response first where the fault alters it. */
async function answer(route: Route, fault: Fault, random: () => number): Promise<void> {
  if (fault === 'reset') return route.abort('connectionreset');
  if (fault === 'disconnected') return route.abort('internetdisconnected');
  if (fault === 'error-500') return route.fulfill({ status: 500, body: 'injected failure' });
  if (fault === 'pass') return route.continue();
  const response = await route.fetch();
  const body = await response.body();
  if (fault === 'slow') await new Promise((resolve) => setTimeout(resolve, 200 + random() * 1800));
  let altered = body;
  if (fault === 'truncated') altered = body.subarray(0, Math.floor(random() * body.length));
  if (fault === 'corrupted') {
    altered = Buffer.from(body);
    for (let i = 0, n = 1 + Math.floor(random() * 32); i < n && altered.length > 0; i++)
      altered[Math.floor(random() * altered.length)] = Math.floor(random() * 256);
  }
  // A truncated or corrupted body keeps the original headers: Content-Length must follow the new body.
  const headers = { ...response.headers() };
  delete headers['content-length'];
  delete headers['content-encoding'];
  return route.fulfill({ status: response.status(), headers, body: altered });
}

/** Puts every response whose URL matches `pattern` behind the injector, which starts enabled. */
export async function injectChaos(page: Page, pattern: string | RegExp, random: () => number): Promise<Chaos> {
  const chaos: Chaos = {
    enabled: true,
    counts: { pass: 0, reset: 0, disconnected: 0, 'error-500': 0, slow: 0, truncated: 0, corrupted: 0 },
  };
  await page.route(pattern, async (route) => {
    const fault = chaos.enabled ? pick(random) : 'pass';
    chaos.counts[fault]++;
    // A request the page aborted meanwhile cannot be answered; any other failure must not leave it hanging.
    await answer(route, fault, random).catch(() => route.abort('failed').catch(() => undefined));
  });
  return chaos;
}

/** A random navigation path of `steps` around `places`: jumps, frame-by-frame moves, flights and still frames. */
export function randomPath(
  random: () => number,
  places: readonly { longitudeDeg: number; latitudeDeg: number }[],
  steps: number,
) {
  const place = () => {
    const at = places[Math.floor(random() * places.length)] ?? { longitudeDeg: 0, latitudeDeg: 0 };
    return {
      longitudeDeg: at.longitudeDeg + (random() - 0.5) * 2,
      latitudeDeg: at.latitudeDeg + (random() - 0.5) * 2,
      zoom: 5 + random() * 5,
    };
  };
  const path: (
    | { jump: ReturnType<typeof place> }
    | { move: ReturnType<typeof place>; frames: number }
    | { fly: ReturnType<typeof place>; durationMs: number }
    | { hold: number }
  )[] = [{ jump: place() }, { hold: 10 }];
  for (let i = 0; i < steps; i++) {
    const roll = random();
    if (roll < 0.2) path.push({ jump: place() });
    else if (roll < 0.6) path.push({ move: place(), frames: 10 + Math.floor(random() * 30) });
    else if (roll < 0.8) path.push({ fly: place(), durationMs: 1000 + random() * 2000 });
    else path.push({ hold: 5 + Math.floor(random() * 30) });
  }
  path.push({ hold: 20 });
  return path;
}

/**
 * A LAN package server (offline mode 1) under the injector: the files of `files`, with range requests, under
 * `/offline-fixtures/`, each answer passed through the faults while `chaos.enabled`. Its own route, because a route's
 * `fetch()` bypasses the other routes of the page; shaped like `servePackages` of `e2e/support/offline.ts`. The
 * first read of a package file gets `firstFault`.
 */
export async function serveFaultyPackages(page: Page, random: () => number, firstFault: Fault = 'pass') {
  let first = true;
  const server = {
    files: new Map<string, Buffer | string>(),
    requests: [] as { path: string; range: string | undefined }[],
  };
  const chaos: Chaos = {
    enabled: true,
    counts: { pass: 0, reset: 0, disconnected: 0, 'error-500': 0, slow: 0, truncated: 0, corrupted: 0 },
  };
  await page.route('**/offline-fixtures/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/offline-fixtures\//, '');
    const range = request.headers()['range'];
    server.requests.push({ path, range });
    // A broken manifest makes the host's own `addServedPackage` call fail with a typed error: the faults hit the
    // package file, which the reader must survive (corrupted data reads as missing, F309, F310).
    let fault: Fault = chaos.enabled && !path.endsWith('manifest.json') ? pick(random) : 'pass';
    // `firstFault` makes sure the first read of the file is hit: a small package is read once, in one chunk.
    if (chaos.enabled && first && !path.endsWith('manifest.json')) {
      first = false;
      if (firstFault !== 'pass') fault = firstFault;
    }
    chaos.counts[fault]++;
    if (fault === 'reset' || fault === 'disconnected' || fault === 'error-500')
      return answer(route, fault, random).catch(() => undefined);
    const file = server.files.get(path);
    if (file === undefined) return route.fulfill({ status: 404, body: 'not found' });
    let body = typeof file === 'string' ? Buffer.from(file) : file;
    let status = 200;
    const headers: Record<string, string> = {
      'Content-Type': typeof file === 'string' ? 'application/json' : 'application/octet-stream',
    };
    const match = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (match && typeof file !== 'string') {
      const start = Number(match[1]);
      const end = Math.min(body.length - 1, Number(match[2]));
      headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
      body = body.subarray(start, end + 1);
      status = 206;
    }
    if (fault === 'slow') await new Promise((resolve) => setTimeout(resolve, 200 + random() * 1800));
    if (fault === 'truncated') body = body.subarray(0, Math.floor(random() * body.length));
    if (fault === 'corrupted') {
      body = Buffer.from(body);
      for (let i = 0, n = 1 + Math.floor(random() * 32); i < n && body.length > 0; i++)
        body[Math.floor(random() * body.length)] = Math.floor(random() * 256);
    }
    return route.fulfill({ status, headers, body }).catch(() => undefined);
  });
  return { server, chaos };
}
