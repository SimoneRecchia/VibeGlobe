import { describe, expect, it } from 'vitest';
import type { ImagerySource } from '../imagery/imagery-source.js';
import type { WorkerEndpointFactory, WorkerRequest } from '../scheduler/worker-protocol.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { createGlobe } from './create-globe.js';
import { fakeRenderer } from './test-renderer.js';

/** Workers that decode every tile at once. */
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

const imagery: ImagerySource = {
  id: 'fixture',
  tiling: WEB_MERCATOR_TILING,
  minLevel: 0,
  maxLevel: 18,
  tileSizePx: 256,
  pixelRatio: 1,
  transport: {
    start(_request, _timeouts, done) {
      queueMicrotask(() => done({ kind: 'ok', bytes: new ArrayBuffer(4), contentType: 'image/png' }));
      return () => undefined;
    },
  },
  decoder: 'image',
  request: (coord, out) => {
    out.url = `/tiles/${coord.level}/${coord.x}/${coord.y}.png`;
    out.hostIndex = 0;
    return out;
  },
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function globeWithImagery(source: ImagerySource = imagery) {
  const { renderer, factory } = fakeRenderer();
  const globe = createGlobe({
    container: {},
    renderer: factory,
    baseImageryUrl: 'world.jpg',
    imagery: [source],
    workers: instantWorkers(),
    view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 },
  });
  const run = async (frames: number, until?: () => boolean): Promise<void> => {
    for (let i = 0; i < frames && !until?.(); i++) {
      await settle();
      renderer.timers.advance(16);
      renderer.flush();
    }
  };
  await run(60);
  const finest = (): number => Math.max(...globe.surfaceTiles().map((tile) => tile.imageryLevel ?? 0));
  return { globe, renderer, run, finest };
}

describe('captureView (F416)', () => {
  it('captures the view at a size larger than the canvas with tiles at its resolution, then returns to the live size', async () => {
    const { globe, renderer, run, finest } = await globeWithImagery();
    const liveLevel = finest();
    const frames = globe.frameNumber;
    let done = false;
    const capture = globe.captureView({ widthPx: 2400, heightPx: 2400 }).finally(() => (done = true));
    let captureLevel = 0;
    await run(400, () => {
      captureLevel = Math.max(captureLevel, finest());
      return done;
    });
    const image = await capture;
    expect(image.widthPx).toBe(2400);
    expect(image.heightPx).toBe(2400);
    expect(image.rgba.length).toBe(2400 * 2400 * 4);
    // Four times the canvas's pixels per side: two imagery levels finer, which the live view showed while loading.
    expect(captureLevel).toBeGreaterThanOrEqual(liveLevel + 2);
    expect(globe.frameNumber - frames).toBeGreaterThan(2);
    // The drawing buffer is back at the canvas size, and the selection at the live resolution.
    expect(renderer.bufferPx).toEqual({ widthPx: 800, heightPx: 600 });
    await run(60);
    expect(finest()).toBe(liveLevel);
    globe.destroy();
  });

  it('rejects sizes that are not positive integers or need a drawing buffer beyond the largest texture', async () => {
    const { globe } = await globeWithImagery();
    for (const size of [
      { widthPx: 0, heightPx: 10 },
      { widthPx: 10.5, heightPx: 10 },
      {},
      { widthPx: 5000, heightPx: 10 },
    ])
      await expect(globe.captureView(size as { widthPx: number; heightPx: number })).rejects.toMatchObject({
        code: 'invalid-option',
      });
    globe.destroy();
    await expect(globe.captureView({ widthPx: 10, heightPx: 10 })).rejects.toMatchObject({ code: 'destroyed' });
  });

  it('refuses a view with Google content, which is display only (ADR 0031)', async () => {
    const { globe } = await globeWithImagery({ ...imagery, profile: { id: 'google', displayOnly: true } });
    await expect(globe.captureView({ widthPx: 100, heightPx: 100 })).rejects.toMatchObject({
      code: 'display-only',
      message: expect.stringContaining("captureView is refused: source 'fixture'") as string,
    });
    globe.destroy();
  });
});
