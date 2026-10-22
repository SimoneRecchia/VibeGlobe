import type { AbortHandle, TileRequest, TileTransport, TimeoutsMs, TransportResult } from '@vibeglobe/core';

/** Cuts the tile out of an image fetched with a gutter: `gutterPx` on every side of a `sizePx` square. */
export type CropImage = (
  bytes: ArrayBuffer,
  contentType: string,
  gutterPx: number,
  sizePx: number,
) => Promise<ArrayBuffer>;

/**
 * Crops in the browser: decoded by `createImageBitmap` (off the main thread in current browsers) and re-encoded as
 * PNG by an `OffscreenCanvas`, so the engine's decoder receives an ordinary tile image.
 */
export const cropInBrowser: CropImage = async (bytes, contentType, gutterPx, sizePx) => {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: contentType }), gutterPx, gutterPx, sizePx, sizePx);
  try {
    const canvas = new OffscreenCanvas(sizePx, sizePx);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D context');
    context.drawImage(bitmap, 0, 0);
    return await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  } finally {
    bitmap.close();
  }
};

/**
 * Wraps a transport for WMS GetMap answers: an XML service exception is a permanent failure (status 400, so the tile
 * is not asked again and its parent stays), and with a gutter the tile is cropped out of the larger image. An image
 * that cannot be cropped is no data. `done` is still called exactly once.
 */
export function wmsTransport(base: TileTransport, gutterPx: number, sizePx: number, crop: CropImage): TileTransport {
  return {
    start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle {
      let settled = false;
      const finish = (result: TransportResult): void => {
        if (settled) return;
        settled = true;
        done(result);
      };
      const abortBase = base.start(request, timeouts, (result) => {
        if (result.kind !== 'ok') return finish(result);
        if (/xml/i.test(result.contentType)) return finish({ kind: 'status', status: 400, retryAfterMs: undefined });
        if (gutterPx === 0 || result.bytes.byteLength === 0) return finish(result);
        crop(result.bytes, result.contentType, gutterPx, sizePx).then(
          (bytes) => finish({ kind: 'ok', bytes, contentType: 'image/png' }),
          () => finish({ kind: 'ok', bytes: new ArrayBuffer(0), contentType: '' }),
        );
      });
      return () => {
        if (settled) return;
        abortBase();
        finish({ kind: 'aborted' });
      };
    },
  };
}
