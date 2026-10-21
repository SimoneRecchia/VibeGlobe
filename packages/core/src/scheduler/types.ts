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
  | { readonly kind: 'ok'; readonly bytes: ArrayBuffer; readonly contentType: string }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterMs: number | undefined }
  | { readonly kind: 'network-error' | 'timeout' | 'aborted' };

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
