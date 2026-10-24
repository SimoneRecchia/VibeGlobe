// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Google Photorealistic 3D Tiles (F468–F470, F323; ADR 0031, ADR 0141) through the Map Tiles API with the customer's
 * own key: the root tileset (`v1/3dtiles/root.json`) starts a session, whose token Google writes into the tileset's
 * content URIs; every later request carries the current session and the key, which only this adapter's transport adds
 * (the engine and its logs see URLs without them). A session lasts about three hours: the adapter starts a new one
 * before `sessionLifetimeMs` runs out, and once more when Google refuses a request (400, 401, 403), retrying that
 * request, so no tile fails because a token expired. The Google profile applies: display only (picking and tile
 * data refused, F323), no persistent cache, prefetch or offline packaging, Google's logo and the tiles' copyrights.
 */
import type { AbortHandle, TileTransport, TimeoutsMs, TransportResult } from '@vibeglobe/core';
import { retryAfterMs } from '../fetch-transport.js';
import { SourceConfigError } from '../metadata.js';
import {
  assertAvailableInRegion,
  googleProfile,
  type GoogleProfile,
  type GoogleSourceOptions,
} from './google-provider.js';

/** Options of {@link google3dTiles}. */
export interface Google3DTilesOptions extends Omit<GoogleSourceOptions, 'language' | 'region'> {
  /** A name for errors and credits; default `google-3d-tiles`. */
  readonly id?: string;
  /** How long a session is used before a new one starts; default 2 h 45 min (Google's sessions last about 3 h). */
  readonly sessionLifetimeMs?: number;
}

/** The adapter: what `tiles3d({ ... })` of `@vibeglobe/sources/tiles3d` takes, and its session counters. */
export interface Google3DTiles {
  readonly id: string;
  /** The root tileset's URL, without key or session. */
  readonly url: string;
  readonly transport: TileTransport;
  readonly profile: GoogleProfile;
  /** Sessions started so far (root tileset requests). */
  readonly sessionsCreated: () => number;
}

const DEFAULT_LIFETIME_MS = (2 * 60 + 45) * 60_000;
const SESSION = /[?&]session=([^&"\\\s]+)/;
const REFUSED = new Set([400, 401, 403]);

interface Session {
  readonly token: string;
  readonly startedAtMs: number;
}

/** The current session: started from the root tileset, renewed before its lifetime ends or after a refusal. */
class Sessions {
  private current: Promise<Session> | undefined;
  created = 0;

  constructor(
    private readonly rootUrl: string,
    private readonly lifetimeMs: number,
    private readonly fetchRoot: (url: string) => Promise<Response>,
  ) {}

  /** Starts a session: fetches the root tileset and reads the token from its content URIs. */
  start(): Promise<Session> {
    this.created++;
    const started = Date.now();
    const pending = this.fetchRoot(this.rootUrl).then(async (response) => {
      if (!response.ok) throw new StatusError(response.status, response.headers.get('Retry-After'));
      const token = SESSION.exec(await response.clone().text())?.[1];
      if (token === undefined) throw new Error('the root tileset names no session');
      return { token: decodeURIComponent(token), startedAtMs: started, response };
    });
    this.current = pending;
    pending.catch(() => {
      if (this.current === pending) this.current = undefined;
    });
    return pending;
  }

  /** The token to use now. */
  async token(): Promise<string> {
    const pending = this.current ?? this.start();
    const session = await pending;
    if (Date.now() - session.startedAtMs < this.lifetimeMs) return session.token;
    if (this.current === pending) this.start();
    return (await (this.current ?? this.start())).token;
  }

  /** Google refused `token`: one new session for every request that saw the same refusal. */
  async refused(token: string): Promise<string> {
    const pending = this.current;
    const session = await pending?.catch(() => undefined);
    if (this.current === pending && (!session || session.token === token)) this.start();
    return this.token();
  }
}

class StatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** `url` with this session and key, replacing the session Google wrote into the tileset. */
function signed(url: string, token: string | undefined, key: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('key');
  parsed.searchParams.delete('session');
  if (token !== undefined) parsed.searchParams.set('session', token);
  parsed.searchParams.set('key', key);
  return parsed.href;
}

async function result(response: Response): Promise<TransportResult> {
  if (!response.ok)
    return {
      kind: 'status',
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), Date.now()),
    };
  return { kind: 'ok', bytes: await response.arrayBuffer(), contentType: response.headers.get('Content-Type') ?? '' };
}

/**
 * Google Photorealistic 3D Tiles for `tiles3d` (`@vibeglobe/sources/tiles3d`):
 * `tiles3d({ ...google3dTiles({ apiKey, billingRegion }), meshes: threeTileMeshes })`.
 */
export function google3dTiles(options: Google3DTilesOptions): Google3DTiles {
  if (!options.apiKey) throw new SourceConfigError('missing-api-key', 'Google 3D Tiles: apiKey is required');
  const profile = googleProfile(options.billingRegion, options.logoUrl);
  assertAvailableInRegion(profile.billingRegion, 'photorealistic-3d-tiles');
  const base = (options.baseUrl ?? 'https://tile.googleapis.com/').replace(/\/?$/, '/');
  const url = `${base}v1/3dtiles/root.json`;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const get = (target: string, signal?: AbortSignal): Promise<Response> =>
    fetchImpl(target, { mode: 'cors', credentials: 'omit', ...(signal ? { signal } : {}) });
  const sessions = new Sessions(url, options.sessionLifetimeMs ?? DEFAULT_LIFETIME_MS, (root) =>
    get(signed(root, undefined, options.apiKey)),
  );
  const load = async (target: string, signal: AbortSignal): Promise<TransportResult> => {
    if (target.split('?')[0] === url) {
      const session = await sessions.start();
      return result((session as Session & { response: Response }).response);
    }
    const token = await sessions.token();
    const response = await get(signed(target, token, options.apiKey), signal);
    if (!REFUSED.has(response.status)) return result(response);
    return result(await get(signed(target, await sessions.refused(token), options.apiKey), signal));
  };
  const transport: TileTransport = {
    start(request, timeouts: TimeoutsMs, done): AbortHandle {
      const controller = new AbortController();
      let settled = false;
      const finish = (value: TransportResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(value);
      };
      const timer = setTimeout(() => {
        finish({ kind: 'timeout' });
        controller.abort();
      }, timeouts.totalMs);
      load(request.url, controller.signal).then(finish, (error: unknown) =>
        finish(
          error instanceof StatusError
            ? { kind: 'status', status: error.status, retryAfterMs: retryAfterMs(error.retryAfter, Date.now()) }
            : controller.signal.aborted
              ? { kind: 'aborted' }
              : { kind: 'network-error' },
        ),
      );
      return () => {
        controller.abort();
        finish({ kind: 'aborted' });
      };
    },
  };
  return { id: options.id ?? 'google-3d-tiles', url, transport, profile, sessionsCreated: () => sessions.created };
}
