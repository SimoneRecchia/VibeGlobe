import { Session } from 'node:inspector/promises';
import { describe, expect, it } from 'vitest';
import type { TileRequest, TileTransport, TransportResult } from '../scheduler/types.js';
import type { WorkerEndpointFactory, WorkerRequest } from '../scheduler/worker-protocol.js';
import type { TerrainSource } from '../terrain/terrain-source.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { createGlobe } from './create-globe.js';
import type { GlobeError } from './errors.js';
import type { ViewInit } from './types.js';
import { fakeRenderer } from './test-renderer.js';

/** The fixture terrain: linear in global Web Mercator x and y (0–1), so every grid interpolates it exactly. */
function heightAt(globalX: number, globalY: number): number {
  return 1000 + 2000 * globalX - 500 * globalY;
}

const CELLS = 4;

/**
 * Workers that decode a tile's bytes (its level, x and y) into a grid of `height` at once, reporting a fixed 0–3,000 m
 * range, or with `actualRange` each grid's own.
 */
function terrainWorkers(height = heightAt, actualRange = false): WorkerEndpointFactory {
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
              heights[row * (CELLS + 1) + col] = height((x + col / CELLS) / n, (y + row / CELLS) / n);
          const [minMeters, maxMeters] = actualRange ? [Math.min(...heights), Math.max(...heights)] : [0, 3000];
          const image = { cells: CELLS, heightsMeters: heights, minMeters, maxMeters };
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

/**
 * View curves that keep M4's geometry: the globe at every zoom, never flattened, with full relief (M5's Auto curves
 * flatten the globe from ground zoom 4 and raise relief only from 10).
 */
const GLOBE_WITH_RELIEF = {
  morph: { startGroundZoom: 40, endGroundZoom: 41 },
  relief: { startGroundZoom: -2, endGroundZoom: -1 },
  tilt: { startGroundZoom: 41, endGroundZoom: 42 },
};

/** A globe over the fixture terrain, advanced `frames` frames. */
async function terrainGlobe(
  source: TerrainSource,
  frames = 30,
  workers = terrainWorkers(),
  view: ViewInit = { longitudeDeg: 7, latitudeDeg: 46, zoom: 9 },
) {
  const { renderer, factory } = fakeRenderer();
  const globe = createGlobe({
    container: {},
    renderer: factory,
    baseImageryUrl: 'world.jpg',
    terrain: source,
    workers,
    view,
    viewCurves: GLOBE_WITH_RELIEF,
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

interface SamplingNode {
  callFrame: { url: string; functionName: string; lineNumber: number };
  selfSize: number;
  children: SamplingNode[];
}

/** Sampled bytes per allocation site (file:function:line), module top levels left out (as frame-allocation.test.ts). */
function allocationSites(node: SamplingNode, out: Map<string, number>): Map<string, number> {
  const topLevel = node.callFrame.functionName === '' && node.callFrame.lineNumber === 0;
  if (node.selfSize > 0 && !topLevel) {
    const site = `${node.callFrame.url}:${node.callFrame.functionName}:${node.callFrame.lineNumber + 1}`;
    out.set(site, (out.get(site) ?? 0) + node.selfSize);
  }
  for (const child of node.children) allocationSites(child, out);
  return out;
}

/** Engine sources, tests excluded. */
const ENGINE_SOURCE = /\/packages\/core\/src\/(?!.*\.test\.ts)/;

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

  it("reports each tile's terrain level and error, within τ_terrain below the source's levels, and the terrain counters (F126, F134)", async () => {
    const { globe } = await terrainGlobe(terrain([]));
    const tiles = globe.surfaceTiles();
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      // Two levels coarser than the surface tile, or an ancestor's.
      expect(tile.terrainLevel).not.toBeNull();
      expect(tile.terrainLevel ?? 99).toBeLessThanOrEqual(Math.max(0, tile.level - 2));
      // Below the source's deepest level (8), a selected tile's terrain error is at most τ_terrain, 2 px.
      if (tile.level - 2 < 8) expect(tile.terrainErrorPx).toBeLessThanOrEqual(2);
    }
    const stats = globe.terrainStats();
    expect(stats).toMatchObject({
      queued: 0,
      loading: 0,
      decoding: 0,
      uploadsPending: 0,
      uploadBudgetBytes: 8_000_000,
    });
    expect(stats?.ready).toBeGreaterThan(0);
    expect(stats?.msLastFrame).toBeGreaterThanOrEqual(0);
    globe.destroy();
  });

  it('refines a tile by its own relief, not the highest terrain anywhere: a far peak adds no tiles near a low eye (KB-077)', async () => {
    // Low land (100 m) everywhere, and a 8,000 m plateau on the other side of the world in the second case.
    const low = (): number => 100;
    const farPeak = (x: number): number => (x > 0.75 ? 8000 : 100);
    const view = { longitudeDeg: 7, latitudeDeg: 46, zoom: 15, tiltDeg: 60 };
    const counts: number[] = [];
    for (const height of [low, farPeak]) {
      const { globe } = await terrainGlobe(terrain([]), 40, terrainWorkers(height, true), view);
      counts.push(globe.surfaceStats().tiles);
      globe.destroy();
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeLessThanOrEqual(Math.ceil((counts[0] ?? 0) * 1.1));
  });

  it('keeps the tile count bounded while only coarse terrain, with errors of tens of kilometers, is resident (KB-077)', async () => {
    // Heightmap-sized errors (39 km at level 0) and the finer levels failing: the coarse grids' heights, not their
    // errors, set the tiles' distances.
    const coarse = (failing: boolean): TerrainSource => ({
      ...terrain([], 12, failing ? (level) => level > 1 : undefined),
      geometricErrorMeters: (level) => 39_136 / 2 ** level,
    });
    const view = { longitudeDeg: 7, latitudeDeg: 46, zoom: 15, tiltDeg: 60 };
    const counts: number[] = [];
    for (const failing of [false, true]) {
      const { globe } = await terrainGlobe(
        coarse(failing),
        40,
        terrainWorkers(() => 100, true),
        view,
      );
      counts.push(globe.surfaceStats().tiles);
      globe.destroy();
    }
    expect(counts[1]).toBeLessThanOrEqual(Math.ceil((counts[0] ?? 0) * 1.1));
  });

  it('keeps the tile count bounded at street level beside a cliff while only coarse terrain is resident (KB-080)', async () => {
    // Low land (1,000 m) with a 4,000 m cliff about 800 m east of the eye: coarse grids span both sides, so their
    // highest height lies far above the ground under the eye.
    const cliffX = (7.01 + 180) / 360;
    const cliff = (x: number): number => (x > cliffX ? 4000 : 1000);
    const view = { longitudeDeg: 7, latitudeDeg: 46, zoom: 21, tiltDeg: 75, headingDeg: 90 };
    const counts: number[] = [];
    for (const failing of [undefined, (level: number) => level > 1]) {
      const { globe } = await terrainGlobe(terrain([], 16, failing), 40, terrainWorkers(cliff, true), view);
      counts.push(globe.surfaceStats().tiles);
      globe.destroy();
    }
    expect(counts[0]).toBeGreaterThan(0);
    // The coarse grid shows other relief (its cell slopes from 1,000 to 4,000 m across the eye's region), so a few more
    // tiles are near it; before the fix the coarse case selected twice as many (5,179 against 2,427).
    expect(counts[1]).toBeLessThanOrEqual(Math.ceil((counts[0] ?? 0) * 1.25));
  });

  it('morphs the relief of tiles that appear when the selection changes, ending on the target terrain exactly (F138)', async () => {
    const { globe, renderer, run } = await terrainGlobe(terrain([]), 40, terrainWorkers(), {
      longitudeDeg: 7,
      latitudeDeg: 46,
      zoom: 10,
      tiltDeg: 30,
    });
    // Back to zoom 9: parents replace their children, whose finer terrain was shown until now.
    globe.jumpTo({ zoom: 9 });
    renderer.timers.advance(16);
    renderer.flush();
    const first = renderer.lastDraws;
    const morphing = Array.from(first?.terrain.fades.subarray(0, first.count) ?? []).filter((fade) => fade < 1);
    expect(morphing.length).toBeGreaterThan(0);
    // Each morph runs from the terrain shown before to the tile's own; once over, only the target terrain is drawn.
    await run(30);
    const last = renderer.lastDraws;
    if (!last) throw new Error('no draws');
    for (let i = 0; i < last.count; i++) {
      expect(last.terrain.fades[i]).toBe(1);
      expect(last.terrain.fromTextures[i]).toBe(last.terrain.textures[i]);
    }
    globe.destroy();
  });

  it('advances the relief of a tile at most two levels per morph when several finer levels arrive at once (KB-092)', async () => {
    // Levels above 4 are held back until released, then all answer in the same frame.
    const held: (() => void)[] = [];
    let holding = true;
    const base = terrain([], 12);
    const transport = terrainTransport([]);
    const source: TerrainSource = {
      ...base,
      transport: {
        start: (request, timeouts, done) => {
          const level = Number(request.url.split('/').at(-3));
          if (!holding || level <= 4) return transport.start(request, timeouts, done);
          held.push(() => transport.start(request, timeouts, done));
          return () => undefined;
        },
      },
    };
    const { globe, renderer, run } = await terrainGlobe(source, 40, terrainWorkers(), {
      longitudeDeg: 7,
      latitudeDeg: 46,
      zoom: 11,
    });
    holding = false;
    for (const release of held.splice(0)) release();
    // Every frame, no tile's relief jumps more than two levels: each change is a morph (ADR 0028).
    const shown = new Map<number, number>();
    let advanced = false;
    for (let frame = 0; frame < 120; frame++) {
      await run(1);
      const draws = renderer.lastDraws;
      if (!draws) continue;
      for (let i = 0; i < draws.count; i++) {
        const key = draws.meshKeys[i] ?? 0;
        const level = globe.surfaceTiles()[i]?.terrainLevel ?? -1;
        const before = shown.get(key);
        if (before !== undefined && before >= 0 && level >= 0) {
          expect(level - before).toBeLessThanOrEqual(2);
          if (level > 4) advanced = true;
        }
        shown.set(key, level);
      }
    }
    expect(advanced).toBe(true);
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

  it('answers 10,000 queries at random positions without allocating (F144)', async () => {
    const { globe } = await terrainGlobe(terrain([]));
    const out = { heightMeters: 0, level: 0, noData: true };
    // A position object the caller reuses: GeoPosition is readonly to the engine, not to its owner.
    const position = { longitudeDeg: 0, latitudeDeg: 0 };
    let seed = 1;
    const queries = (count: number): number => {
      let sum = 0;
      for (let i = 0; i < count; i++) {
        seed = (seed * 16807) % 2147483647;
        position.longitudeDeg = (seed / 2147483647) * 360 - 180;
        position.latitudeDeg = (((seed * 7) % 2147483647) / 2147483647) * 170 - 85;
        sum += globe.elevationAt(position, out).heightMeters;
      }
      return sum;
    };
    // Long enough a warm-up for the query path to be optimized even on a busy machine: unoptimized code boxes doubles.
    queries(200_000);
    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 64,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const count = 200_000;
    expect(Number.isFinite(queries(count))).toBe(true);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as { profile: { head: SamplingNode } };
    session.disconnect();
    const engine = [...allocationSites(profile.head, new Map())].filter(([site]) => ENGINE_SOURCE.test(site));
    // Any object allocated per query costs at least 12 bytes; under 0.01 byte per query on average means none does.
    const bytesPerQuery = engine.reduce((sum, [, bytes]) => sum + bytes, 0) / count;
    expect(bytesPerQuery, JSON.stringify(engine)).toBeLessThan(0.01);
    globe.destroy();
  }, 60_000);

  it('answers the ellipsoid, flagged no-data, without terrain (F144)', async () => {
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w' });
    await settle();
    renderer.flush();
    expect(globe.terrainStats()).toBeUndefined();
    expect(globe.surfaceTiles().every((tile) => tile.terrainLevel === null)).toBe(true);
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

  it('settles a query whose deeper availability comes with the metadata of an ancestor, off screen (F145)', async () => {
    // Levels below 2 are known only once the level-2 tile covering them, which carries their availability, has loaded;
    // then they turn out to have no data there.
    const urls: string[] = [];
    let carrierLoaded = false;
    const base = terrain(urls, 12);
    const source: TerrainSource = {
      ...base,
      transport: {
        start(request, timeouts, done) {
          return base.transport.start(request, timeouts, (result) => {
            if (request.url.startsWith('/terrain/2/')) carrierLoaded = true;
            done(result);
          });
        },
      },
      request: (coord, out) => (coord.level <= 2 ? base.request(coord, out) : carrierLoaded ? 'noData' : 'unknown'),
    };
    const { globe, run } = await terrainGlobe(source, 5);
    // The other side of the world from the view.
    const query = globe.elevationAtAsync({ longitudeDeg: -170.5, latitudeDeg: -40.25 });
    let settled = false;
    void query.then(() => (settled = true));
    await run(40);
    expect(settled).toBe(true);
    expect((await query).level).toBe(2);
    globe.destroy();
  });

  it('rejects a query whose availability can never be known, its metadata tile failing for good (F145)', async () => {
    const base = terrain([], 12);
    const source: TerrainSource = {
      ...base,
      transport: {
        start(request, timeouts, done) {
          // The level-2 tile that would carry the deeper levels' availability is corrupt.
          if (request.url.startsWith('/terrain/2/'))
            queueMicrotask(() => done({ kind: 'ok', bytes: new ArrayBuffer(3), contentType: 'image/png' }));
          else return base.transport.start(request, timeouts, done);
          return () => undefined;
        },
      },
      request: (coord, out) => (coord.level <= 2 ? base.request(coord, out) : 'unknown'),
    };
    const workers = terrainWorkers();
    const corruptAware: WorkerEndpointFactory = {
      ...workers,
      create(onMessage, onError) {
        const endpoint = workers.create(onMessage, onError);
        return {
          ...endpoint,
          post(message: WorkerRequest, transfer: readonly object[]) {
            if (message.kind === 'run' && (message.input as { bytes: ArrayBuffer }).bytes.byteLength === 3) {
              queueMicrotask(() =>
                onMessage({ kind: 'reply', id: message.id, ok: false, error: { code: 'undecodable', message: 'bad' } }),
              );
              return;
            }
            endpoint.post(message, transfer);
          },
        };
      },
    };
    const { globe, run } = await terrainGlobe(source, 5, corruptAware);
    const query = globe.elevationAtAsync({ longitudeDeg: -170.5, latitudeDeg: -40.25 });
    let error: unknown;
    query.catch((reason: unknown) => (error = reason));
    await run(60);
    expect(error).toMatchObject({ code: 'resource-failed' } satisfies Partial<GlobeError>);
    globe.destroy();
  });

  it('wants only the finest tile of a query point while its availability is known (F145)', async () => {
    const urls: string[] = [];
    const { globe, run } = await terrainGlobe(terrain(urls, 12), 5);
    const before = urls.length;
    const query = globe.elevationAtAsync({ longitudeDeg: -170.5, latitudeDeg: -40.25 });
    await run(40);
    expect((await query).level).toBe(12);
    // The level-12 tile, and none of the levels between it and the pinned base.
    const requested = urls.slice(before).filter((url) => !/^\/terrain\/[0-2]\//.test(url));
    expect(requested).toEqual([expect.stringMatching(/^\/terrain\/12\//)]);
    globe.destroy();
  });

  it('rejects a query with resource-failed when its finest tile keeps failing or timing out (F145)', async () => {
    for (const mode of ['failing', 'silent'] as const) {
      const base = terrain([], 8);
      const source: TerrainSource = {
        ...base,
        timeoutsMs: { firstByteMs: 100, totalMs: 200 },
        transport: {
          start(request, timeouts, done) {
            if (!request.url.startsWith('/terrain/8/')) return base.transport.start(request, timeouts, done);
            // Level 8 answers 500 every time, or never answers (the network pool's watchdog times it out).
            if (mode === 'failing')
              queueMicrotask(() => done({ kind: 'status', status: 500, retryAfterMs: undefined }));
            return () => undefined;
          },
        },
      };
      const { globe, renderer, run } = await terrainGlobe(source, 5);
      const query = globe.elevationAtAsync({ longitudeDeg: 7.2, latitudeDeg: 46.1 });
      let error: unknown;
      query.catch((reason: unknown) => (error = reason));
      // Retries back off for up to a minute or so: advance well past them.
      for (let i = 0; i < 200 && error === undefined; i++) {
        renderer.timers.advance(2000);
        await run(1);
      }
      expect(error).toMatchObject({ code: 'resource-failed' } satisfies Partial<GlobeError>);
      globe.destroy();
    }
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
    const ground = globe.elevationAt({ longitudeDeg: camera.eyeLongitudeDeg, latitudeDeg: camera.eyeLatitudeDeg });
    expect(ground.noData).toBe(false);
    expect(camera.altitudeMeters).toBeGreaterThan(1000);
    // The eye's own position: its height above the terrain under it is at least the default 10 m (within the
    // interpolation of the displayed mesh), and the camera reports the displayed ground it keeps clear of.
    expect(camera.altitudeMeters - ground.heightMeters).toBeGreaterThanOrEqual(9.9);
    expect(camera.groundHeightMeters).toBeCloseTo(ground.heightMeters, 1);
    expect(camera.altitudeMeters - camera.groundHeightMeters).toBeGreaterThanOrEqual(10 - 1e-6);
    globe.destroy();
  });

  it('scales Mercator terrain error with latitude: a view near the pole selects about as many tiles as without terrain (KB-090)', async () => {
    const view = { longitudeDeg: 0, latitudeDeg: 84.5, zoom: 6, tiltDeg: 50 };
    const counts: number[] = [];
    for (const source of [undefined, terrain([], 12)]) {
      const { renderer, factory } = fakeRenderer();
      const globe = createGlobe({
        container: {},
        renderer: factory,
        baseImageryUrl: 'w',
        workers: terrainWorkers(),
        view,
        ...(source ? { terrain: source } : {}),
      });
      for (let frame = 0; frame < 40; frame++) {
        await settle();
        renderer.timers.advance(16);
        renderer.flush();
      }
      counts.push(globe.surfaceStats().tiles);
      globe.destroy();
    }
    expect(counts[1]).toBeLessThanOrEqual(2 * (counts[0] ?? 0));
  });

  it('stops drawing once the eye has settled above the terrain (KB-089)', async () => {
    const { globe, run } = await terrainGlobe(terrain([]), 60, terrainWorkers(), {
      longitudeDeg: 7,
      latitudeDeg: 46,
      zoom: 22,
      tiltDeg: 60,
    });
    await run(60);
    const settled = globe.frameNumber;
    await run(30);
    expect(globe.frameNumber).toBe(settled);
    globe.destroy();
  });

  it('decodes a third-party encoding through a custom decoder, between frames (F132)', async () => {
    const custom: TerrainSource = {
      ...terrain([]),
      id: 'custom-float32',
      decoder: {
        kind: 'custom',
        decode: (bytes, coord) => {
          const [level = 0, x = 0, y = 0] = new Float64Array(bytes);
          expect([level, x, y]).toEqual([coord.level, coord.x, coord.y]);
          const n = 2 ** level;
          const heights = new Float32Array(4).map((_, i) => heightAt((x + (i % 2)) / n, (y + (i >> 1)) / n));
          return { cells: 1, heightsMeters: heights, minMeters: 0, maxMeters: 3000 };
        },
      },
    };
    const { globe } = await terrainGlobe(custom);
    const sample = globe.elevationAt({ longitudeDeg: 7.2, latitudeDeg: 46.1 });
    const [x, y] = mercator(7.2, 46.1);
    expect(sample.noData).toBe(false);
    expect(sample.heightMeters).toBeCloseTo(heightAt(x, y), 2);
    globe.destroy();
  });

  it('selects the stored set of terrain tiles for scripted cameras (F126)', async () => {
    const cameras = [
      { longitudeDeg: 7, latitudeDeg: 46, zoom: 9 },
      { longitudeDeg: 7, latitudeDeg: 46, zoom: 12, tiltDeg: 60, headingDeg: 30 },
      { longitudeDeg: -122.4, latitudeDeg: 37.8, zoom: 14, tiltDeg: 45 },
    ];
    const sets: string[][] = [];
    for (const view of cameras) {
      const { globe } = await terrainGlobe(terrain([], 12), 120, terrainWorkers(), view);
      // Each drawn tile and the terrain tile level it shows.
      sets.push(
        globe
          .surfaceTiles()
          .map((t) => `${t.root}/${t.level}/${t.x}/${t.y}:${t.terrainLevel ?? '-'}`)
          .sort(),
      );
      globe.destroy();
    }
    expect(sets).toMatchSnapshot();
  });

  it('deepens the skirts of tiles showing terrain coarser than their level, by that terrain error (M4 review)', async () => {
    const view = { longitudeDeg: 7, latitudeDeg: 46, zoom: 10, tiltDeg: 30 };
    /** Each draw's extra skirt depth, and whether it shows terrain coarser than its own level's. */
    const skirts = async (failing?: (level: number) => boolean): Promise<{ meters: number; fallback: boolean }[]> => {
      const { globe, renderer } = await terrainGlobe(terrain([], 12, failing), 120, terrainWorkers(), view);
      const draws = renderer.lastDraws;
      const tiles = globe.surfaceTiles();
      const values = tiles.slice(0, draws?.count ?? 0).map((tile, i) => ({
        meters: draws?.terrain.skirtMeters[i] ?? 0,
        fallback: (tile.terrainLevel ?? -1) < Math.min(12, Math.max(0, tile.level - 2)),
      }));
      globe.destroy();
      return values;
    };
    // Every level loads: each tile shows its own level's terrain.
    expect((await skirts()).every(({ meters }) => meters === 0)).toBe(true);
    // Levels below 2 fail: tiles wanting finer terrain show level-2 terrain, whose error (1.5 × 2,500 m) is twice what
    // their skirts get.
    const fallback = await skirts((level) => level > 2);
    expect(fallback.some(({ fallback }) => fallback)).toBe(true);
    for (const draw of fallback) if (draw.fallback) expect(draw.meters).toBe(2 * 1.5 * 2500);
    // One subtree missing: its tiles show coarser terrain, and their neighbors showing their own level get the same
    // deeper skirts, so the higher of two edges always reaches the lower one.
    const base = terrain([], 12);
    const holed: TerrainSource = {
      ...base,
      transport: terrainTransport([], (level) => level > 7),
      request: (coord, out) => {
        const request = base.request(coord, out);
        // Only level-8 tile x = 132 and its subtree fail; elsewhere the requests go to a transport that works.
        if (request !== 'noData' && request !== 'unknown' && (coord.level < 8 || coord.x >> (coord.level - 8) !== 132))
          request.url = request.url.replace('/terrain/', '/terrain-ok/');
        return request;
      },
    };
    const okTransport = terrainTransport([]);
    const transport = holed.transport;
    const mixed: TerrainSource = {
      ...holed,
      transport: {
        start: (request, timeouts, done) =>
          (request.url.startsWith('/terrain-ok/') ? okTransport : transport).start(
            { ...request, url: request.url.replace('/terrain-ok/', '/terrain/') },
            timeouts,
            done,
          ),
      },
    };
    // Closer in, so a terrain tile's border crosses the view.
    const { globe, renderer } = await terrainGlobe(mixed, 120, terrainWorkers(), { ...view, zoom: 11 });
    const draws = renderer.lastDraws;
    const tiles = globe.surfaceTiles();
    let fallbackDraws = 0;
    let deepenedNeighbors = 0;
    for (let i = 0; i < (draws?.count ?? 0); i++) {
      const tile = tiles[i];
      const own = Math.min(12, (tile?.level ?? 0) - 2);
      const shown = tile?.terrainLevel ?? -1;
      const meters = draws?.terrain.skirtMeters[i] ?? 0;
      if (shown < own) fallbackDraws++;
      else if (meters > 0) deepenedNeighbors++;
    }
    expect(fallbackDraws).toBeGreaterThan(0);
    expect(deepenedNeighbors).toBeGreaterThan(0);
    globe.destroy();
  });

  it('fails the tiles of a custom decoder that returns non-finite heights (F132)', async () => {
    const custom: TerrainSource = {
      ...terrain([]),
      id: 'custom-nan',
      decoder: {
        kind: 'custom',
        decode: () => ({ cells: 1, heightsMeters: Float32Array.of(0, Number.NaN, 0, 0), minMeters: 0, maxMeters: 0 }),
      },
    };
    const { globe } = await terrainGlobe(custom);
    expect(globe.terrainStats()?.failed).toBeGreaterThan(0);
    expect(globe.elevationAt({ longitudeDeg: 7.2, latitudeDeg: 46.1 }).noData).toBe(true);
    globe.destroy();
  });

  it('converts geoid heights to ellipsoidal ones before queries (F133)', async () => {
    // A uniform 30 m geoid: every ellipsoidal height is the geoid height plus 30 m.
    const model = { rows: 3, columns: 4, undulationsMeters: new Float32Array(12).fill(30) };
    const { globe } = await terrainGlobe({ ...terrain([]), datum: { kind: 'geoid', model } });
    const position = { longitudeDeg: 7.2, latitudeDeg: 46.1 };
    const [x, y] = mercator(7.2, 46.1);
    expect(globe.elevationAt(position).heightMeters).toBeCloseTo(heightAt(x, y) + 30, 2);
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
