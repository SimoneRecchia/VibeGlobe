/**
 * Contracts between the tile scheduler, the network transport, the worker pool and the caches (ADR 0007, ADR 0011,
 * docs/plan/m3-imagery-streaming.md §2.2). Core stays DOM-free: sources implement the transport with `fetch` and
 * `AbortController`, `@vibeglobe/worker` implements the worker endpoints.
 */

/** Where one tile comes from: written by a source for a tile coordinate, reused across requests. */
export interface TileRequest {
  /** The URL to fetch. */
  url: string;
  /** Index of the host the URL points to, for per-host concurrency (F089). */
  hostIndex: number;
}

/** Time limits of one request (F092), in milliseconds. */
export interface TimeoutsMs {
  /** Until the response headers arrive. */
  firstByteMs: number;
  /** For the whole body. */
  totalMs: number;
}

/** How a transport request ended. */
export type TransportResult =
  | {
      readonly kind: 'ok';
      readonly bytes: ArrayBuffer;
      readonly contentType: string;
      /**
       * How long the response may be reused, from its `Cache-Control` (`max-age`, `no-store`, `no-cache`) or `Expires`
       * header; absent without such headers. Sources whose provider profile respects cache headers reuse the tile
       * only that long, in memory as on the GPU (F260).
       */
      readonly maxAgeMs?: number;
      /** Milliseconds from the request to the response's headers, when the transport knows: the link's latency (F303). */
      readonly waitMs?: number;
      /**
       * Milliseconds from the response's headers to its last byte, and since that last byte, as the network saw them
       * (Resource Timing), when the transport knows: the main thread may notice a response's end a frame late (F300).
       */
      readonly transferMs?: number;
      readonly endAgoMs?: number;
      /** Served from the HTTP cache: not a measure of the link. */
      readonly cached?: boolean;
    }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterMs: number | undefined }
  | { readonly kind: 'timeout' | 'aborted' }
  /** `cause` 'cors': the server answers but sends no CORS headers, so the browser withholds the bytes (F251). */
  | { readonly kind: 'network-error'; readonly cause?: 'cors' };

/** Cancels a request in flight (F090). Calling it after the request ended does nothing. */
export type AbortHandle = () => void;

/** Fetches tile bytes. `done` is called exactly once, also after an abort (with kind 'aborted'). */
export interface TileTransport {
  start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle;
}

/** A decoded image tile, ready for upload: an `ImageBitmap` in browsers, raw RGBA in tests and Node. */
export interface DecodedTile {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Bytes the texture will take on the GPU, mip chain included (ADR 0007 §byte accounting). */
  readonly gpuBytes: number;
  /** The image itself, opaque to core: the renderer knows how to upload it. */
  readonly image: unknown;
}
