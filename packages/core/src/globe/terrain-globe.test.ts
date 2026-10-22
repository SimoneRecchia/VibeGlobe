import { describe, expect, it } from 'vitest';
import type { TileRequest, TileTransport, TransportResult } from '../scheduler/types.js';
import type { WorkerEndpointFactory, WorkerRequest } from '../scheduler/worker-protocol.js';
import type { TerrainSource } from '../terrain/terrain-source.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { createGlobe } from './create-globe.js';
import type { GlobeError } from './errors.js';
import { fakeRenderer } from './test-renderer.js';

/** The fixture terrain: linear in global Web Mercator x and y (0–1), so every grid interpolates it exactly. */
function heightAt(globalX: number, globalY: number): number {
  return 1000 + 2000 * globalX - 500 * globalY;
}

const CELLS = 4;

/** Workers that decode a tile's bytes (its level, x and y) into a grid of the fixture terrain at once. */
function terrainWorkers(): WorkerEndpointFactory {
  return {
    url: 'instant-worker',
    inline: () => Promise.reject(new Error('not used')),
    create(onMessage) {
      queueMicrotask(() => onMessage({ kind: 'ready', version: 1, buildId: '' }));
      return {
        post(message: WorkerRequest) {
          if (message.kind !== 'run') return;
          const [level = 0, x = 0, y = 0] = new Float64Array((message.input as { bytes: ArrayBuffer }).bytes);
          const n = 2 ** level;
          const heights = new Float32Array((CELLS + 1) ** 2);
          for (let row = 0; row <= CELLS; row++)
            for (let col = 0; col <= CELLS; col++)
              heights[row * (CELLS + 1) + col] = heightAt((x + col / CELLS) / n, (y + row / CELLS) / n);
          const image = { cells: CELLS, heightsMeters: heights, minMeters: 0, maxMeters: 3000 };
          const output = { widthPx: CELLS + 1, heightPx: CELLS + 1, gpuBytes: heights.byteLength, image };
          queueMicrotask(() => onMessage({ kind: 'reply', id: message.id, ok: true, output }));
        },
        terminate: () => undefined,
      };
    },
  };
}

/** A transport answering each tile with its level, x and y as bytes; tiles of `failing` levels fail with 404. */
function terrainTransport(urls: string[], failing?: (level: number) => boolean): TileTransport {
  return {
    start(request: TileRequest, _timeouts, done: (result: TransportResult) => void) {
      urls.push(request.url);
      const [level = 0, x = 0, y = 0] = request.url.split('/').slice(-3).map(Number);
      queueMicrotask(() =>
        failing?.(level)
          ? done({ kind: 'status', status: 404, retryAfterMs: undefined })
          : done({ kind: 'ok', bytes: Float64Array.of(level, x, y).buffer, contentType: 'image/png' }),
      );
      return () => undefined;
    },
  };
}

function terrain(urls: string[], maxLevel = 8, failing?: (level: number) => boolean): TerrainSource {
  return {
    id: 'fixture-terrain',
    tiling: WEB_MERCATOR_TILING,
    minLevel: 0,
    maxLevel,
    transport: terrainTransport(urls, failing),
    decoder: { kind: 'terrarium' },
    datum: { kind: 'ellipsoid' },
    geometricErrorMeters: (level) => 10_000 / 2 ** level,
    request: (coord, out) => {
      out.url = `/terrain/${coord.level}/${coord.x}/${coord.y}`;
      out.hostIndex = 0;
      return out;
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A globe over the fixture terrain, advanced `frames` frames. */
async function terrainGlobe(source: TerrainSource, frames = 30) {
  const { renderer, factory } = fakeRenderer();
  const globe = createGlobe({
    container: {},
    renderer: factory,
    baseImageryUrl: 'world.jpg',
    terrain: source,
    workers: terrainWorkers(),
    view: { longitudeDeg: 7, latitudeDeg: 46, zoom: 9 },
  });
  const run = async (count: number): Promise<void> => {
    for (let frame = 0; frame < count; frame++) {
      await settle();
      renderer.timers.advance(16);
      renderer.flush();
    }
  };
  await run(frames);
  return { globe, renderer, run };
}

/** Global Web Mercator x and y (0–1) of a position. */
function mercator(lonDeg: number, latDeg: number): [number, number] {
  const lat = (latDeg * Math.PI) / 180;
  return [(lonDeg + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2];
}

describe('terrain in a globe (M4)', () => {
  it('draws terrain height grids on the surface tiles, the deepest resident one per tile (F126, F139)', async () => {
    const urls: string[] = [];
    const { globe, renderer } = await terrainGlobe(terrain(urls));
    const draws = renderer.lastDraws;
    const heights = Array.from(draws?.terrain.textures.subarray(0, draws.count) ?? []);
    expect(heights.length).toBeGreaterThan(0);
    expect(heights.every((handle) => handle >= 0)).toBe(true);
    // Every terrain tile is requested once.
    expect(new Set(urls).size).toBe(urls.length);
    globe.destroy();
  });

  it('answers elevation queries from the terrain in memory with the level they came from (F144)', async () => {
    const { globe } = await terrainGlobe(terrain([]));
    const out = { heightMeters: 0, level: 0, noData: true };
    for (const [lon, lat] of [
      [7, 46],
      [7.3, 45.8],
      [-120, -30],
      [179.9, 80],
    ] as const) {
      const sample = globe.elevationAt({ longitudeDeg: lon, latitudeDeg: lat }, out);
      expect(sample).toBe(out);
      expect(sample.noData).toBe(false);
      expect(sample.level).toBeGreaterThanOrEqual(0);
      const [x, y] = mercator(lon, lat);
      // Float32 heights near 3,000 m keep about 0.25 mm.
      expect(sample.heightMeters).toBeCloseTo(heightAt(x, y), 2);
    }
    // The view's own area has finer terrain than the other side of the world.
    const near = globe.elevationAt({ longitudeDeg: 7, latitudeDeg: 46 }).level;
    expect(near).toBeGreaterThan(globe.elevationAt({ longitudeDeg: -120, latitudeDeg: -30 }).level);
    globe.destroy();
  });

  it('answers the ellipsoid, flagged no-data, without terrain (F144)', async () => {
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w' });
    await settle();
    renderer.flush();
    expect(globe.elevationAt({ longitudeDeg: 7, latitudeDeg: 46 })).toEqual({
      heightMeters: 0,
      level: -1,
      noData: true,
    });
    await expect(globe.elevationAtAsync({ longitudeDeg: 7, latitudeDeg: 46 })).resolves.toEqual({
      heightMeters: 0,
      level: -1,
      noData: true,
    });
    globe.destroy();
  });

  it('loads the finest terrain for an asynchronous query, each tile once, and settles every query (F145)', async () => {
    const urls: string[] = [];
    const { globe, run } = await terrainGlobe(terrain(urls, 12), 5);
    const position = { longitudeDeg: -60.25, latitudeDeg: -20.5 };
    const queries = Array.from({ length: 1000 }, (_, i) =>
      globe.elevationAtAsync({ longitudeDeg: position.longitudeDeg + i * 1e-6, latitudeDeg: position.latitudeDeg }),
    );
    await run(40);
    const samples = await Promise.all(queries);
    expect(samples.every((sample) => sample.level === 12 && !sample.noData)).toBe(true);
    const [x, y] = mercator(position.longitudeDeg, position.latitudeDeg);
    expect(samples[0]?.heightMeters).toBeCloseTo(heightAt(x, y), 2);
    expect(new Set(urls).size).toBe(urls.length);
    // An aborted query rejects with 'aborted'.
    const controller = new AbortController();
    const aborted = globe.elevationAtAsync({ longitudeDeg: 100, latitudeDeg: 10 }, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' } satisfies Partial<GlobeError>);
    globe.destroy();
  });

  it('settles a query whose finest levels have no data with the finest level that has, and rejects on destroy (F145)', async () => {
    const { globe, run } = await terrainGlobe(
      terrain([], 12, (level) => level > 9),
      5,
    );
    const query = globe.elevationAtAsync({ longitudeDeg: 30, latitudeDeg: 0 });
    await run(40);
    await expect(query).resolves.toMatchObject({ level: 9, noData: false });
    const pending = globe.elevationAtAsync({ longitudeDeg: -30, latitudeDeg: 5 });
    globe.destroy();
    await expect(pending).rejects.toMatchObject({ code: 'destroyed' });
  });

  it('keeps the eye the clearance above the displayed terrain, and lowers it back over the ellipsoid (F146)', async () => {
    const { globe, run } = await terrainGlobe(terrain([]));
    // The fixture terrain is about 1,300 m high here; a jump to street level would put the eye inside it.
    globe.jumpTo({ longitudeDeg: 7, latitudeDeg: 46, zoom: 22, tiltDeg: 60 });
    await run(20);
    const camera = globe.camera;
    const ground = globe.elevationAt({ longitudeDeg: camera.longitudeDeg, latitudeDeg: camera.latitudeDeg });
    expect(ground.noData).toBe(false);
    expect(camera.altitudeMeters).toBeGreaterThan(1000);
    // The eye's own position: its height above the terrain under it is at least the default 10 m (within the
    // interpolation of the displayed mesh).
    expect(camera.altitudeMeters - ground.heightMeters).toBeGreaterThanOrEqual(9.9);
    globe.destroy();
  });

  it('rejects a terrain source with an unknown vertical datum, naming the source (F133)', () => {
    const { factory } = fakeRenderer();
    const source = { ...terrain([]), datum: { kind: 'navd88' } } as unknown as TerrainSource;
    expect(() =>
      createGlobe({
        container: {},
        renderer: factory,
        baseImageryUrl: 'w',
        terrain: source,
        workers: terrainWorkers(),
      }),
    ).toThrowError(/terrain source fixture-terrain: unknown vertical datum/);
    expect(() =>
      createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', terrain: terrain([]) }),
    ).toThrowError(/workers is required when terrain is set/);
  });
});
