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
    await settle();
    renderer.flush();
    await globe.ready;
    // The first frame shows the base image everywhere and requests the imagery.
    const first = renderer.lastDraws;
    expect(Array.from(first?.textures.subarray(0, first.count) ?? [])).toEqual(new Array(first?.count).fill(-1));
    expect(urls.length).toBeGreaterThan(0);
    for (let frame = 0; frame < 30; frame++) {
      await settle();
      renderer.timers.advance(16);
      renderer.flush();
    }
    const draws = renderer.lastDraws;
    const textured = Array.from(draws?.textures.subarray(0, draws.count) ?? []).filter((handle) => handle >= 0);
    expect(textured.length).toBe(draws?.count);
    expect(renderer.textures.size).toBeGreaterThan(0);
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
