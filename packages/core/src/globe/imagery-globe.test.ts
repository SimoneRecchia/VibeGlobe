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

  it('refines to full detail after a jump, drawing until the motion has settled (KB-131)', async () => {
    const berlin = { longitudeDeg: 13.4, latitudeDeg: 52.5, zoom: 7 };
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'world.jpg',
      imagery: [source([])],
      workers: instantWorkers(),
      view: berlin,
    });
    const run = async (): Promise<void> => {
      for (let frame = 0; frame < 120; frame++) {
        await settle();
        renderer.timers.advance(16);
        renderer.flush();
      }
    };
    await run();
    const tiles = (): string =>
      globe
        .surfaceTiles()
        .map((t) => `${t.level}/${t.x}/${t.y}`)
        .sort()
        .join(' ');
    const still = tiles();
    // A fast pan east and back (jumps are no motion for motion-aware detail), then rest.
    void globe.easeTo({ ...berlin, longitudeDeg: berlin.longitudeDeg + 1 }, { durationMs: 300 });
    await run();
    void globe.easeTo(berlin, { durationMs: 300 });
    await run();
    expect(tiles()).toBe(still);
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
      {
        id: 'fixture',
        crs: 'EPSG:3857',
        minLevel: 0,
        maxLevel: 18,
        tileSizePx: 256,
        pixelRatio: 1,
        attribution: [],
        keepInMemory: true,
        prefetch: true,
        authenticated: false,
      },
    ]);
    globe.destroy();
  });
});

describe('tile sizes and high-DPI variants (F240, F241)', () => {
  /** The finest imagery level drawn once `globe`'s imagery has settled; every tile's texels stay within 1.5 px. */
  async function settledLevel(
    globe: ReturnType<typeof createGlobe>,
    renderer: ReturnType<typeof fakeRenderer>['renderer'],
  ): Promise<number> {
    for (let frame = 0; frame < 30; frame++) {
      await settle();
      renderer.timers.advance(16);
      renderer.flush();
    }
    for (const tile of globe.surfaceTiles()) expect(tile.texelErrorPx).toBeLessThanOrEqual(1.5);
    return Math.max(...globe.surfaceTiles().map((tile) => tile.imageryLevel ?? -1));
  }

  function variantSource(urls: string[], tileSizePx: number, highDpi: boolean): ImagerySource {
    return {
      ...source(urls),
      tileSizePx,
      ...(highDpi ? { highDpi: true } : {}),
      request: (coord, out, pixelRatio = 1) => {
        out.url = `/tiles/${coord.level}/${coord.x}/${coord.y}${pixelRatio > 1 ? '@2x' : ''}.png`;
        out.hostIndex = 0;
        return out;
      },
    };
  }

  async function levelFor(tileSizePx: number, highDpi: boolean, resolutionScale: number): Promise<number> {
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'world.jpg',
      imagery: [variantSource([], tileSizePx, highDpi)],
      workers: instantWorkers(),
      resolutionScale,
      view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 },
    });
    const level = await settledLevel(globe, renderer);
    globe.destroy();
    return level;
  }

  it('draws 512-pixel tiles one level coarser than 256-pixel tiles at the same view, as densely on screen', async () => {
    expect(await levelFor(512, false, 1)).toBe((await levelFor(256, false, 1)) - 1);
  });

  it('draws @2x tiles on a 2x canvas at the level of 1x tiles on a 1x canvas, where 1x tiles refine one level', async () => {
    const level = await levelFor(256, true, 1);
    expect(await levelFor(256, true, 2)).toBe(level);
    expect(await levelFor(256, false, 2)).toBe(level + 1);
  });

  it('requests @2x tiles only above one render-target pixel per CSS pixel, switching with the resolution scale', async () => {
    const urls: string[] = [];
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'world.jpg',
      imagery: [variantSource(urls, 256, true)],
      workers: instantWorkers(),
      view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 },
    });
    await settledLevel(globe, renderer);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes('@2x'))).toBe(false);
    urls.length = 0;
    globe.setResolutionScale(2);
    await settledLevel(globe, renderer);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.includes('@2x'))).toBe(true);
    urls.length = 0;
    globe.setResolutionScale(1);
    await settledLevel(globe, renderer);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes('@2x'))).toBe(false);
    globe.destroy();
  });
});

describe('imagery layers added and removed at runtime (track A hook 2)', () => {
  it('adds a layer at an index, loads and draws its tiles, removes one with its textures, and reports each change', async () => {
    const urlsA: string[] = [];
    const urlsB: string[] = [];
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'world.jpg',
      imagery: [source(urlsA)],
      workers: instantWorkers(),
      view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 },
    });
    const run = async (frames: number): Promise<void> => {
      for (let frame = 0; frame < frames; frame++) {
        await settle();
        renderer.timers.advance(50);
        renderer.flush();
      }
    };
    await run(30);
    const changes: string[][] = [];
    globe.on('imagery-layers-change', ({ layers }) => changes.push(layers.map((layer) => layer.id)));
    const second: ImagerySource = { ...source(urlsB), id: 'second' };
    globe.imageryLayers.add({ id: 'roads', sources: [second], opacity: 0.5 }, 0);
    expect(globe.imageryLayers.list().map((layer) => layer.id)).toEqual(['roads', 'fixture']);
    await run(30);
    expect(urlsB.length).toBeGreaterThan(0);
    const texturesBefore = renderer.textures.size;
    expect(globe.imageryLayers.remove('fixture')).toBe(true);
    expect(globe.imageryLayers.remove('fixture')).toBe(false);
    await run(5);
    expect(renderer.textures.size).toBeLessThan(texturesBefore);
    expect(globe.imageryLayers.list().map((layer) => layer.id)).toEqual(['roads']);
    expect(changes).toEqual([['roads', 'fixture'], ['roads']]);
    // An id taken or invalid metadata is refused with a typed error.
    expect(() => globe.imageryLayers.add({ ...second })).toThrowError(/source already has the id "second"/);
    expect(() => globe.imageryLayers.add({ id: 'roads', sources: [{ ...source([]), id: 'third' }] })).toThrowError(
      /layer already has the id "roads"/,
    );
    expect(() => globe.imageryLayers.add({ ...source([]), id: 'bad', minLevel: 9, maxLevel: 3 })).toThrowError(
      /minimum level 9 above its maximum 3/,
    );
    globe.destroy();
  });
});

describe('flight destination preloading (F286, F285)', () => {
  async function flightRequests(loadingFlags?: number): Promise<{ urls: string[]; destination: string }> {
    const urls: string[] = [];
    const { renderer, factory } = fakeRenderer();
    const flyer: ImagerySource = {
      ...source(urls),
      ...(loadingFlags === undefined ? {} : { loadingFlags: () => loadingFlags }),
    };
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'world.jpg',
      imagery: [flyer],
      workers: instantWorkers(),
      view: { longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 9 },
    });
    for (let frame = 0; frame < 30; frame++) {
      await settle();
      renderer.timers.advance(50);
      renderer.flush();
    }
    urls.length = 0;
    void globe.flyTo({ longitudeDeg: 139.7, latitudeDeg: 35.7, zoom: 9 }, { durationMs: 8000 });
    // The first frames of the flight, still over Europe.
    for (let frame = 0; frame < 3; frame++) {
      await settle();
      renderer.timers.advance(16);
      renderer.flush();
    }
    globe.destroy();
    // Tokyo's tile at level 9 or 10 (the destination's level).
    const n = 2 ** 9;
    const x = Math.floor(((139.7 + 180) / 360) * n);
    return { urls, destination: `/tiles/9/${x}/` };
  }

  it('requests the destination tiles at their arrival level as soon as a flight starts', async () => {
    const { urls } = await flightRequests();
    const tokyo = urls.filter((url) => /\/tiles\/(9|10)\/(45[0-9]|9[01][0-9])\//.test(url));
    expect(tokyo.length).toBeGreaterThan(0);
  });

  it('loads nothing ahead for a source whose loading flags forbid prefetch (F285)', async () => {
    const { urls } = await flightRequests(1);
    expect(urls.filter((url) => /\/tiles\/(9|10)\/(45[0-9]|9[01][0-9])\//.test(url))).toEqual([]);
  });
});

describe('provider warnings (KB-PT-07, F267)', () => {
  it("logs a profile's warning once per engine instance, however many of its sources are added", async () => {
    const logged: string[] = [];
    const warning = 'public servers are for light use only';
    const profiled = (id: string): ImagerySource => ({ ...source([]), id, profile: { id: 'osm-public', warning } });
    const open = async () => {
      const { renderer, factory } = fakeRenderer();
      const globe = createGlobe({
        container: {},
        renderer: factory,
        baseImageryUrl: 'world.jpg',
        imagery: [profiled('a'), profiled('b')],
        workers: instantWorkers(),
        logSink: ({ level, message }) => level === 'warn' && logged.push(message),
      });
      for (let frame = 0; frame < 5; frame++) {
        await settle();
        renderer.timers.advance(50);
        renderer.flush();
      }
      return globe;
    };
    const globe = await open();
    globe.imageryLayers.add({ id: 'c', sources: [profiled('c')] });
    expect(logged).toEqual([warning]);
    // Another engine instance warns again.
    await open();
    expect(logged).toEqual([warning, warning]);
  });
});
