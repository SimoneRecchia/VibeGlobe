// An imagery source whose tiles the page draws itself (a checkerboard with the tile's address), through a custom
// transport: the source contract without any tile server, as an application's own adapter would use it.
import type { ImagerySource } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';

/** Draws the tile at `z/x/y` as PNG bytes. */
async function drawTile(z: number, x: number, y: number): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(256, 256);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2D context');
  context.fillStyle = (x + y) % 2 === 0 ? '#2f6f4f' : '#3f7f9f';
  context.fillRect(0, 0, 256, 256);
  context.strokeStyle = '#e0e0e0';
  context.strokeRect(0.5, 0.5, 255, 255);
  context.fillStyle = '#ffffff';
  context.font = '20px sans-serif';
  context.fillText(`${z}/${x}/${y}`, 12, 32);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

/** The generated source: Web Mercator tiles to level 18, credited to the example. */
export function generatedImagery(): ImagerySource {
  return xyzImagery({
    id: 'generated',
    url: 'generated://{z}/{x}/{y}',
    maxLevel: 18,
    attribution: [{ text: 'Generated tiles', url: 'https://example.com/generated' }],
    transport: {
      start(request, _timeouts, done) {
        let aborted = false;
        const [z = 0, x = 0, y = 0] = request.url.replace('generated://', '').split('/').map(Number);
        drawTile(z, x, y).then(
          (bytes) => !aborted && done({ kind: 'ok', bytes, contentType: 'image/png' }),
          () => !aborted && done({ kind: 'network-error' }),
        );
        return () => {
          if (aborted) return;
          aborted = true;
          done({ kind: 'aborted' });
        };
      },
    },
  });
}

/**
 * A `fetch` that answers the generated source's URLs with drawn tiles (and every other `generated://` URL with an empty
 * 200, for the offline engine's health checks), and passes anything else to the browser's: the offline engine's
 * network tier then serves this source as it would a tile server.
 */
export const generatedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('generated://')) return fetch(input, init);
  const [z, x, y] = url.replace('generated://', '').split('/').map(Number);
  if (z === undefined || x === undefined || y === undefined || [z, x, y].some(Number.isNaN))
    return new Response(null, { status: 200 });
  return new Response(await drawTile(z, x, y), { status: 200, headers: { 'Content-Type': 'image/png' } });
};
