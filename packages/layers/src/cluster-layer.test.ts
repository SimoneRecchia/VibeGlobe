import { describe, expect, it } from 'vitest';
import { frameAt, point, randomPoints } from './__fixtures__/test-support.js';
import type { GeoPosition } from '@vibeglobe/core';
import { localClusterEngine, type ClusterItem } from './cluster.js';
import { ClusterLayer } from './cluster-layer.js';
import { LayerStack } from './layer-stack.js';
import { RecordingRenderTarget } from './testing.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('clustered point layer', () => {
  // Building the 100,000-point index takes about 1.3 s in plain Node and several times longer under coverage.
  it('keeps cluster counts summing to the number of points at every zoom (F373)', { timeout: 20_000 }, async () => {
    const engine = localClusterEngine();
    const points = randomPoints(100_000);
    await engine.load(
      Float64Array.from(points.flatMap((f) => (f.geometry?.type === 'Point' ? f.geometry.coordinates : []))),
      { radiusPx: 60 },
    );
    // Zooms where clusters form (above zoom 10 almost every one of these points stands alone).
    for (const zoom of [0, 2, 4, 6, 8, 10]) {
      const items = await engine.items(zoom);
      expect(items.reduce((sum, item) => sum + item.count, 0)).toBe(100_000);
    }
  });

  it('asks for a frame when clusters computed elsewhere arrive, so they show without other input (KB-130)', async () => {
    const local = localClusterEngine();
    // An engine whose answers arrive later, as a worker's do.
    const engine = { ...local, items: async (zoom: number) => (await settle(), local.items(zoom)) };
    const layer = new ClusterLayer({ data: randomPoints(1000), engine, cluster: { transitionMs: 0 } });
    let frames = 0;
    const stack = new LayerStack(new RecordingRenderTarget(), () => void frames++);
    stack.add(layer);
    await layer.loaded;
    stack.frame(frameAt(0, 3));
    const before = frames;
    await settle();
    await settle();
    expect(frames).toBeGreaterThan(before);
  });

  it('shows the clusters of the current integer zoom as layer features', async () => {
    const layer = new ClusterLayer({ data: randomPoints(10_000), cluster: { radiusPx: 60, transitionMs: 0 } });
    const target = new RecordingRenderTarget();
    const stack = new LayerStack(target);
    stack.add(layer);
    await layer.loaded;
    for (const zoom of [0, 6, 12, 18]) {
      stack.frame(frameAt(zoom * 100, zoom));
      await settle();
      stack.frame(frameAt(zoom * 100 + 16, zoom + 0.5));
      expect(layer.shownZoom).toBe(zoom);
      expect(layer.shownPointCount()).toBe(10_000);
      expect(target.state({ id: 1 }).count).toBe(layer.shownItems().length);
    }
    expect(layer.shownItems().length).toBe(10_000);
  });

  it('splits and merges with animated transitions instead of pops', async () => {
    const data = [point('a', 10, 10), point('b', 10.02, 10.01), point('c', 10.01, 10.03)];
    const layer = new ClusterLayer({ data, cluster: { radiusPx: 60, transitionMs: 300 } });
    const target = new RecordingRenderTarget();
    const stack = new LayerStack(target);
    stack.add(layer);
    stack.frame(frameAt(0, 5));
    await settle();
    stack.frame(frameAt(16, 5));
    expect(layer.shownItems()).toHaveLength(1);
    const cluster = layer.shownItems()[0] as ClusterItem;
    expect(cluster.count).toBe(3);
    const extent = await layer.clusterExtent(cluster.clusterId as number);
    expect(extent.bounds).toEqual({ westDeg: 10, southDeg: 10, eastDeg: 10.02, northDeg: 10.03 });
    expect(extent.expansionZoom).toBeGreaterThan(5);

    stack.frame(frameAt(32, 17));
    await settle();
    const distances: number[] = [];
    const opacities: number[] = [];
    for (let t = 48; t <= 48 + 400; t += 16) {
      stack.frame(frameAt(t, 17));
      const p = layer.getPosition('p0') as GeoPosition;
      distances.push(Math.hypot(p.longitudeDeg - 10, p.latitudeDeg - 10));
      const old = layer.getFeature(cluster.key);
      opacities.push(old === undefined ? 0 : (target.value({ id: 1 }, 'visible', 0) ?? 0));
    }
    expect(layer.shownItems()).toHaveLength(3);
    expect(layer.shownPointCount()).toBe(3);
    // The child starts on the cluster's position and moves out in small steps, reaching its own position.
    expect(distances[0]).toBeLessThan(0.02);
    expect(distances.at(-1)).toBeCloseTo(0, 9);
    const steps = distances.slice(1).map((d, i) => Math.abs(d - (distances[i] as number)));
    expect(Math.max(...steps)).toBeLessThan(0.006);
    // The cluster fades out over the transition and is then removed.
    expect(layer.getFeature(cluster.key)).toBeUndefined();
    expect(opacities.some((o) => o > 0 && o < 1)).toBe(true);
  });

  it('reports single points as their original features', async () => {
    const layer = new ClusterLayer({
      data: [point('far-1', -100, 40, { name: 'x' }), point('far-2', 100, -40)],
      cluster: { transitionMs: 0 },
    });
    const target = new RecordingRenderTarget();
    const stack = new LayerStack(target);
    stack.add(layer);
    stack.frame(frameAt(0, 3));
    await settle();
    stack.frame(frameAt(16, 3));
    const pickId = target.value({ id: 1 }, 'pickId', 0) as number;
    expect(stack.resolvePick(pickId)?.feature).toMatchObject({ id: 'far-1', properties: { name: 'x' } });
    expect(
      () => new ClusterLayer({ data: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }] }),
    ).toThrow(TypeError);
  });
});

describe('clustered point layer in and out of the stack', () => {
  it('clusters again after being removed and added back (PT-10)', async () => {
    const layer = new ClusterLayer({ data: randomPoints(500), cluster: { radiusPx: 60, transitionMs: 0 } });
    const stack = new LayerStack(new RecordingRenderTarget());
    stack.add(layer);
    await layer.loaded;
    stack.frame(frameAt(0, 3));
    await settle();
    stack.frame(frameAt(16, 3));
    stack.remove(layer);
    stack.add(layer);
    const errors: string[] = [];
    layer.on('error', (e) => errors.push(e.message));
    await layer.loaded;
    stack.frame(frameAt(32, 8));
    await settle();
    stack.frame(frameAt(48, 8));
    expect(errors).toEqual([]);
    expect(layer.shownZoom).toBe(8);
    expect(layer.shownPointCount()).toBe(500);
  });
});
