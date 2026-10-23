import { describe, expect, it } from 'vitest';
import type { ImagerySource } from '../imagery/imagery-source.js';
import type { TileRequest, TileTransport, TransportResult } from '../scheduler/types.js';
import type { WorkerEndpointFactory, WorkerRequest } from '../scheduler/worker-protocol.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { createGlobe } from './create-globe.js';
import { fakeRenderer } from './test-renderer.js';

/** Workers that answer the handshake and decode every tile at once, in the posting task. */
function instantWorkers(): WorkerEndpointFactory {
  return {
    url: 'instant-worker',
    inline: () => Promise.reject(new Error('not used')),
    create(onMessage) {
      queueMicrotask(() => onMessage({ kind: 'ready', version: 1, buildId: '' }));
      return {
        post(message: WorkerRequest) {
          if (message.kind !== 'run') return;
          const output = { widthPx: 256, heightPx: 256, gpuBytes: 349_524, image: message.input };
          queueMicrotask(() => onMessage({ kind: 'reply', id: message.id, ok: true, output }));
        },
        terminate: () => undefined,
      };
    },
  };
}

/** A transport that answers every request with the same bytes in a microtask, and records the URLs. */
function instantTransport(urls: string[]): TileTransport {
  return {
    start(request: TileRequest, _timeouts, done: (result: TransportResult) => void) {
      urls.push(request.url);
      queueMicrotask(() => done({ kind: 'ok', bytes: new ArrayBuffer(4), contentType: 'image/png' }));
      return () => undefined;
    },
  };
}

function source(urls: string[], maxLevel = 18): ImagerySource {
  return {
    id: 'fixture',
    tiling: WEB_MERCATOR_TILING,
    minLevel: 0,
    maxLevel,
    tileSizePx: 256,
    pixelRatio: 1,
    transport: instantTransport(urls),
    decoder: 'image',
    request: (coord, out) => {
      out.url = `/tiles/${coord.level}/${coord.x}/${coord.y}.png`;
      out.hostIndex = 0;
      return out;
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('tiled imagery in a globe (M3 increment 3b)', () => {
  it('draws the base image first, then the wanted imagery tiles once they are loaded, decoded and uploaded', async () => {
    const urls: string[] = [];
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'world.jpg',
      imagery: [source(urls)],
      workers: instantWorkers(),
      view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 },
    });
    let ready = false;
    void globe.ready.then(() => (ready = true));
    await settle();
    renderer.flush();
    // The first frame shows the base image everywhere and requests the pinned base and the imagery.
    const first = renderer.lastDraws;
    expect(Array.from(first?.textures.subarray(0, first.count) ?? [])).toEqual(new Array(first?.count).fill(-1));
    expect(urls.length).toBeGreaterThan(0);
    // `ready` waits for the pinned base (levels 0–3 of a 256 px source: 85 tiles, F084).
    expect(ready).toBe(false);
    for (let frame = 0; frame < 30; frame++) {
      await settle();
      renderer.timers.advance(16);
      renderer.flush();
    }
    expect(ready).toBe(true);
    expect(globe.imageryStats()?.pinnedSettled).toBe(85);
    const draws = renderer.lastDraws;
    const textured = Array.from(draws?.textures.subarray(0, draws.count) ?? []).filter((handle) => handle >= 0);
    expect(textured.length).toBe(draws?.count);
    expect(renderer.textures.size).toBeGreaterThan(0);
    // Diagnostics: every tile shows imagery of its own level, its texels within 1.5 px (F081, F083).
    for (const tile of globe.surfaceTiles()) {
      expect(tile.imageryLevel).toBe(tile.level);
      expect(tile.texelErrorPx).toBeLessThanOrEqual(1.5);
    }
    // Every URL is requested once.
    expect(new Set(urls).size).toBe(urls.length);
    globe.destroy();
  });

  it('refuses imagery without a worker pool', () => {
    const { factory } = fakeRenderer();
    expect(() =>
      createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', imagery: [source([])] }),
    ).toThrowError(/workers is required/);
  });
});

describe('source metadata (F220)', () => {
  it('leaves out a source with invalid metadata with a typed error, and keeps drawing the others', async () => {
    const urls: string[] = [];
    const { renderer, factory } = fakeRenderer();
    const broken = { ...source(urls), id: 'broken', minLevel: 9, maxLevel: 3 };
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'world.jpg',
      imagery: [source(urls), broken],
      workers: instantWorkers(),
      logLevel: 'silent',
    });
    const errors: { code: string; message: string }[] = [];
    globe.on('error', (error) => errors.push({ code: error.code, message: error.message }));
    await settle();
    renderer.flush();
    await settle();
    expect(errors).toEqual([
      {
        code: 'invalid-option',
        message: 'Imagery source "broken" has a minimum level 9 above its maximum 3; its layer "broken" is left out',
      },
    ]);
    expect(globe.imageryLayers.list().map((layer) => layer.id)).toEqual(['fixture']);
    // The metadata reads back through the inspection API.
    expect(globe.imageryLayers.list()[0]?.sources).toEqual([
      { id: 'fixture', crs: 'EPSG:3857', minLevel: 0, maxLevel: 18, tileSizePx: 256, pixelRatio: 1, attribution: [] },
    ]);
    globe.destroy();
  });
});
