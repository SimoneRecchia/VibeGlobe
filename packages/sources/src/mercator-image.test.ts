import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TileCoord, TransportResult } from '@vibeglobe/core';
import { failures, runTiledConformance } from './conformance/index.js';
import { fetchTile } from './conformance/tiled.js';
import { mercatorImage, type MercatorImageOptions } from './mercator-image.js';
import { SourceConfigError } from './metadata.js';

const IMAGE_URL = 'https://images.test/night.webp';
const IMAGE = new TextEncoder().encode('IMAGE');
const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const tileBytes = (level: number, x: number, y: number) => new TextEncoder().encode(`${level}/${x}/${y}@256`);
const text = (result: TransportResult | 'noData') =>
  result !== 'noData' && result.kind === 'ok' ? new TextDecoder().decode(result.bytes) : result;

function served(answers: () => Response = () => new Response(IMAGE.slice(0))): typeof fetch & { calls: number } {
  const fetchImpl = Object.assign(
    (input: RequestInfo | URL) => {
      fetchImpl.calls++;
      return Promise.resolve(String(input) === IMAGE_URL ? answers() : new Response(null, { status: 404 }));
    },
    { calls: 0 },
  );
  return fetchImpl as typeof fetch & { calls: number };
}

// Node has no createImageBitmap or OffscreenCanvas: this decoder accepts only the fixture and names each tile it cuts.
function fakeDecoder() {
  const decoder = {
    decodes: 0,
    decodeImage: async (image: Blob) => {
      if ((await image.text()) !== 'IMAGE') throw new Error('not an image');
      decoder.decodes++;
      return (level: number, x: number, y: number, sizePx: number) =>
        Promise.resolve({
          bytes: new TextEncoder().encode(`${level}/${x}/${y}@${sizePx}`).buffer,
          contentType: 'image/png',
        });
    },
  };
  return decoder;
}

function night(fetchImpl: typeof fetch, extra: Partial<MercatorImageOptions> = {}) {
  return mercatorImage({
    id: 'night',
    image: IMAGE_URL,
    maxLevel: 3,
    fetch: fetchImpl,
    downloadTimeoutMs: 300,
    attribution: [{ text: 'Night lights' }],
    decodeImage: fakeDecoder().decodeImage,
    ...extra,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('a single Web Mercator image as tiles (F650)', () => {
  it('passes the tiled conformance suite', async () => {
    const results = await runTiledConformance({
      name: 'Web Mercator image',
      create: (fetchImpl) => night(fetchImpl),
      fixture: served(),
      tiles: [
        { coord: coord(0, 0, 0), bytes: tileBytes(0, 0, 0) },
        { coord: coord(3, 5, 2), bytes: tileBytes(3, 5, 2) },
      ],
    });
    expect(failures(results)).toEqual([]);
  });

  it('downloads and decodes the image once and cuts every tile from it', async () => {
    const fetchImpl = served();
    const decoder = fakeDecoder();
    const source = night(fetchImpl, { decodeImage: decoder.decodeImage });
    const tiles = await Promise.all([coord(0, 0, 0), coord(1, 1, 0), coord(2, 3, 1)].map((c) => fetchTile(source, c)));
    expect(tiles.map((tile) => text(tile.result))).toEqual(['0/0/0@256', '1/1/0@256', '2/3/1@256']);
    expect([fetchImpl.calls, decoder.decodes]).toEqual([1, 1]);
    expect(source.request(coord(4, 0, 0), { url: '', hostIndex: 0 })).toBe('noData');
  });

  it('tries a failed download again with the next tile', async () => {
    let status = 503;
    const fetchImpl = served(() => new Response(status === 200 ? IMAGE.slice(0) : null, { status }));
    const source = night(fetchImpl);
    const failed = await fetchTile(source, coord(1, 0, 0));
    expect(failed.result).toEqual({ kind: 'status', status: 503, retryAfterMs: undefined });
    status = 200;
    expect(text((await fetchTile(source, coord(1, 0, 0))).result)).toBe('1/0/0@256');
    expect(fetchImpl.calls).toBe(2);
  });

  it('cuts each tile from its share of the image in the browser', async () => {
    const drawn: number[][] = [];
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 1024, height: 1024 }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage: (_image: unknown, ...box: number[]) => drawn.push(box) };
        }
        convertToBlob() {
          return Promise.resolve(new Blob([new Uint8Array([7])], { type: 'image/png' }));
        }
      },
    );
    const source = mercatorImage({ id: 'night', image: new Blob([IMAGE]), maxLevel: 3 });
    const tile = await fetchTile(source, coord(2, 3, 1));
    expect(tile.result).toMatchObject({ kind: 'ok', contentType: 'image/png' });
    expect(drawn).toEqual([[768, 256, 256, 256, 0, 0, 256, 256]]);
  });

  it('refuses a maximum level that is not a level', () => {
    for (const maxLevel of [-1, 1.5, 23])
      expect(() => mercatorImage({ id: 'night', image: IMAGE_URL, maxLevel })).toThrow(SourceConfigError);
  });
});
