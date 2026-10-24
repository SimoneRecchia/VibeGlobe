// A consumer's own 3D Tiles adapter for an unusual fixture service that wraps every file of a tileset in a JSON
// envelope, `{ "base64": "..." }`, behind a `?file=` query: the transport the `tiles3d` extension takes (F219). Public
// engine API only.
import type { TileRequest, TileTransport, TimeoutsMs, TransportResult } from '@vibeglobe/core';
import { fetchTransport } from '@vibeglobe/sources';

/** The bytes of a base64 string. */
const fromBase64 = (text: string): ArrayBuffer => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;

/**
 * A transport for tilesets served by the envelope service at `service`: a request for `<service>dir/file.b3dm` fetches
 * `<service>?file=dir/file.b3dm` and unwraps the envelope, so the tileset's relative URIs resolve as usual.
 */
export function envelopeTransport(service: string, inner: TileTransport = fetchTransport()): TileTransport {
  return {
    start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void) {
      const file = request.url.startsWith(service) ? request.url.slice(service.length) : request.url;
      const wrapped = { url: `${service}?file=${encodeURIComponent(file)}`, hostIndex: request.hostIndex };
      return inner.start(wrapped, timeouts, (result) => {
        if (result.kind !== 'ok') return done(result);
        try {
          const envelope: unknown = JSON.parse(new TextDecoder().decode(result.bytes));
          const base64 =
            typeof envelope === 'object' && envelope !== null ? Reflect.get(envelope, 'base64') : undefined;
          if (typeof base64 !== 'string') return done({ kind: 'status', status: 502, retryAfterMs: undefined });
          done({ kind: 'ok', bytes: fromBase64(base64), contentType: 'application/octet-stream' });
        } catch {
          done({ kind: 'status', status: 502, retryAfterMs: undefined });
        }
      });
    },
  };
}
