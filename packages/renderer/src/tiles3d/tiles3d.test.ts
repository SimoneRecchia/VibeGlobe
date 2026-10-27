// The 3D Tiles render extension end to end in Node (F461, F462, F463, F466, F323): the generated fixture city
// (`e2e/fixtures/tiles3d/city.ts`, written to the playground's public folder) streamed by the loader of
// `@vibeglobe/sources/tiles3d`, decoded by `@vibeglobe/models`' `parse-model` task and built into three.js meshes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { geodeticToEcef, GlobeError, MorphFrame, type FrameView, type TileTransport } from '@vibeglobe/core';
import { createModelTasks } from '@vibeglobe/models';
import { tiles3d, type RequestEvent, type Tiles3DExtension, type Tiles3DOptions } from '@vibeglobe/sources/tiles3d';
import { Scene } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { ThreeExtensionContext } from '../extensions.js';
import { threeTileMeshes } from './tile-meshes.js';

const ROOT = fileURLToPath(new URL('../../../../apps/playground/public/tiles3d/', import.meta.url));
const BASE = 'https://tiles.test/city-plain/';
const CENTER = { lon: 12.4922, lat: 41.8902 };
const RAD = Math.PI / 180;

/** Serves the fixture files after `delayMs`, recording the URLs; `hold` keeps responses until released. */
function fixtureTransport(delayMs = 0) {
  const pending: (() => void)[] = [];
  const transport: TileTransport & { hold: boolean; release(): void } = {
    hold: false,
    release() {
      for (const send of pending.splice(0)) send();
    },
    start(request, _timeouts, done) {
      let aborted = false;
      const send = (): void => {
        if (aborted) return;
        const path = request.url.replace('https://tiles.test/', '');
        const bytes = readFileSync(`${ROOT}${path}`);
        done({
          kind: 'ok',
          bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
          contentType: '',
        });
      };
      if (transport.hold) pending.push(send);
      else setTimeout(send, delayMs);
      return () => {
        aborted = true;
        done({ kind: 'aborted' });
      };
    },
  };
  return transport;
}

/** A frame looking straight down at a point from `heightM` above it, 400 × 300 CSS pixels, 60° vertical field. */
function view(lonDeg: number, latDeg: number, heightM: number): FrameView {
  const lon = lonDeg * RAD;
  const lat = latDeg * RAD;
  const eye = new Float64Array(3);
  geodeticToEcef(lon, lat, heightM, eye);
  const e = [-Math.sin(lon), Math.cos(lon), 0];
  const n = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const u = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const v = new Float64Array(16);
  for (let i = 0; i < 3; i++) {
    v[i * 4] = e[i] ?? 0;
    v[i * 4 + 1] = n[i] ?? 0;
    v[i * 4 + 2] = u[i] ?? 0;
  }
  v[15] = 1;
  const f = 1 / Math.tan(Math.PI / 6);
  const p = new Float64Array(16);
  p[0] = f / (400 / 300);
  p[5] = f;
  p[11] = -1;
  p[14] = 0.1;
  return { morph: new MorphFrame(), view: v, projection: p, eyeEcef: eye, widthPx: 400, heightPx: 300, pixelRatio: 1 };
}

const settle = async (extension: Tiles3DExtension, frame: FrameView, rounds = 200): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    extension.frame(frame);
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (i > 2 && extension.stats().loading === 0) {
      extension.frame(frame);
      if (extension.stats().loading === 0) return;
    }
  }
  throw new Error(`not settled: ${JSON.stringify(extension.stats())}`);
};

function create(options: Partial<Tiles3DOptions> = {}, transport = fixtureTransport()) {
  const scene = new Scene();
  const context: ThreeExtensionContext = { scene, depthPath: () => 'reversed-z' };
  let renders = 0;
  const extension = tiles3d({
    url: `${BASE}tileset.json`,
    meshes: threeTileMeshes,
    transport,
    modelTasks: createModelTasks(),
    ...options,
  })({ renderer: context, requestRender: () => renders++, setCredits: () => undefined, report: () => undefined });
  return { extension, scene, transport, renders: () => renders };
}

describe('3D Tiles render extension (F461–F463, F466)', () => {
  it('refines by screen-space error: the root from afar, the leaves up close, nothing missing meanwhile', async () => {
    const { extension } = create();
    await extension.loaded;
    await settle(extension, view(CENTER.lon, CENTER.lat, 20_000));
    expect(extension.debugTiles().map((t) => t.level)).toEqual([0]);
    await settle(extension, view(CENTER.lon, CENTER.lat, 150));
    const levels = new Set(extension.debugTiles().map((t) => t.level));
    expect(levels).toEqual(new Set([3]));
    for (const tile of extension.debugTiles()) expect(tile.screenSpaceErrorPx).toBe(0);
    expect(extension.stats().decodedInline).toBeGreaterThan(0);
  });

  it('requests screen-center tiles first and cancels requests the view no longer wants', async () => {
    const events: RequestEvent[] = [];
    const transport = fixtureTransport();
    const { extension } = create({ onRequest: (e) => events.push(e), maxLoading: 64 }, transport);
    await extension.loaded;
    await settle(extension, view(CENTER.lon, CENTER.lat, 3000));
    events.length = 0;
    transport.hold = true;
    // Down to street level over the city's south-west quarter: the leaves there are wanted.
    const close = view(CENTER.lon - 0.0015, CENTER.lat - 0.0012, 120);
    extension.frame(close);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const starts = events.filter((e) => e.kind === 'start' || e.kind === 'queued');
    expect(starts.length).toBeGreaterThan(1);
    const first = starts[0];
    expect(first?.priority).toBe(Math.min(...starts.map((e) => e.priority)));
    // Fly away before any response: every request in flight is cancelled.
    extension.frame(view(CENTER.lon + 1, CENTER.lat + 1, 120));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelled = events.filter((e) => e.kind === 'cancel').map((e) => e.url);
    expect(cancelled.length).toBe(new Set(starts.map((e) => e.url)).size);
    transport.hold = false;
    transport.release();
  });

  it('keeps loaded content within its budget by evicting the least recently used, and reloads it on return', async () => {
    const { extension, scene } = create({ memoryBudgetBytes: 60_000 });
    await extension.loaded;
    const west = view(CENTER.lon - 0.004, CENTER.lat, 150);
    const east = view(CENTER.lon + 0.004, CENTER.lat, 150);
    await settle(extension, west);
    const westTiles = extension.debugTiles().map((t) => t.id);
    await settle(extension, east);
    expect(extension.stats().evicted).toBeGreaterThan(0);
    expect(extension.stats().bytes).toBeLessThanOrEqual(60_000 + 100_000);
    await settle(extension, west);
    expect(extension.debugTiles().map((t) => t.id)).toEqual(westTiles);
    expect(scene.children.filter((c) => c.visible).length).toBe(westTiles.length);
  });

  it('picks the building under the cursor with its property table values, position and height', async () => {
    const { extension } = create();
    await extension.loaded;
    // Above building (16, 16) of the 32 m grid: its center is 16 m east and north of the city center.
    const metersPerDegLon = 111_320 * Math.cos(CENTER.lat * RAD);
    const lon = CENTER.lon + 16 / metersPerDegLon;
    const lat = CENTER.lat + 16 / 110_950;
    await settle(extension, view(lon, lat, 150));
    const pick = extension.pick(200, 150);
    expect(pick?.properties['name']).toBe('building-16-16');
    expect(pick?.featureId).toBeTypeOf('number');
    const height = Number(pick?.properties['height']);
    expect(pick?.position.heightMeters).toBeCloseTo(height, 0);
    expect(pick?.position.longitudeDeg).toBeCloseTo(lon, 4);
    expect(pick?.position.latitudeDeg).toBeCloseTo(lat, 4);
  });

  it('picks batch table properties of 3D Tiles 1.0 b3dm content', async () => {
    const { extension } = create();
    await extension.loaded;
    await settle(extension, view(CENTER.lon, CENTER.lat, 20_000));
    const pick = extension.pick(200, 150);
    expect(pick?.tileId).toBe('root');
    expect(String(pick?.properties['name'])).toMatch(/^(block-0-|ground)/);
  });

  it('refuses picking and tile data access for a display-only source (F323)', async () => {
    const { extension } = create({ profile: { id: 'google', displayOnly: true } });
    await extension.loaded;
    await settle(extension, view(CENTER.lon, CENTER.lat, 20_000));
    const refused = (call: () => unknown): GlobeError | undefined => {
      try {
        call();
      } catch (error) {
        return error as GlobeError;
      }
      return undefined;
    };
    for (const call of [() => extension.pick(200, 150), () => extension.tileset()]) {
      const error = refused(call);
      expect(error).toBeInstanceOf(GlobeError);
      expect(error?.code).toBe('display-only');
      expect(error?.message).toContain("'google' profile");
    }
  });

  it('frees every mesh on dispose', async () => {
    const { extension, scene } = create();
    await extension.loaded;
    await settle(extension, view(CENTER.lon, CENTER.lat, 1000));
    expect(scene.children.length).toBeGreaterThan(0);
    extension.dispose();
    expect(scene.children.length).toBe(0);
  });
});
