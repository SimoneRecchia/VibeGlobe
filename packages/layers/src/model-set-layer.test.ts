import type { ElevationSample, GeoPosition, Globe, ModelPose, ModelRenderer, ModelSetOptions } from '@vibeglobe/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { LayerStack } from './layer-stack.js';
import { ModelSetLayer, type ModelSetGround } from './model-set-layer.js';
import { RecordingRenderTarget } from './testing.js';

/** A model renderer with sets that records what the layer tells it. */
function fakeSets(): ModelRenderer & {
  loads: { source: unknown; options: ModelSetOptions }[];
  instances: { poses: readonly ModelPose[]; pickIds: readonly number[] } | undefined;
  instanceUploads: number;
  highlights: Map<number, readonly number[] | undefined>;
  visible: boolean;
  removed: number[];
  angles: (Float32Array | undefined)[];
  drawn: number;
} {
  const fake = {
    loads: [] as { source: unknown; options: ModelSetOptions }[],
    instances: undefined as { poses: readonly ModelPose[]; pickIds: readonly number[] } | undefined,
    instanceUploads: 0,
    highlights: new Map<number, readonly number[] | undefined>(),
    visible: true,
    removed: [] as number[],
    angles: [] as (Float32Array | undefined)[],
    drawn: 1,
    load: () => Promise.resolve(99),
    setPose: () => undefined,
    remove: (id: number) => void fake.removed.push(id),
    loadSet: (source: unknown, options: ModelSetOptions) => {
      fake.loads.push({ source, options });
      return Promise.resolve(7);
    },
    setInstances: (_id: number, poses: readonly ModelPose[], pickIds: readonly number[]) => {
      fake.instances = { poses, pickIds };
      fake.instanceUploads++;
    },
    setInstanceHighlight: (_id: number, index: number, rgba: readonly number[] | undefined) =>
      void fake.highlights.set(index, rgba),
    setVisible: (_id: number, visible: boolean) => void (fake.visible = visible),
    setInstanceAngles: (_id: number, joint: number, angles: Float32Array) => void (fake.angles[joint] = angles),
    drawnInstances: () => fake.drawn,
  };
  return fake;
}

describe('model set layer (F627)', () => {
  it('loads its model once for every copy, with poses and pick ids that resolve to them, and highlights a copy', async () => {
    const models = fakeSets();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    const turbines = Array.from({ length: 2000 }, (_, i) => ({
      id: `t${String(i)}`,
      position: { longitudeDeg: 9 + i * 0.001, latitudeDeg: 45 },
      headingDeg: 270,
      properties: { index: i },
    }));
    const layer = stack.add(new ModelSetLayer({ id: 'farm', url: 'turbine.glb', models: turbines }));
    await layer.ready;
    expect(models.loads).toEqual([
      {
        source: { url: 'turbine.glb' },
        options: { visibleBelowMeters: 3000, placeholderColor: [0.95, 0.95, 0.97], placeholderSizePx: 10 },
      },
    ]);
    expect(models.instances?.poses).toHaveLength(2000);
    expect(models.instances?.poses[5]).toEqual({ position: turbines[5]?.position, headingDeg: 270 });
    expect(stack.resolvePick(models.instances?.pickIds[1234] ?? 0)?.feature).toEqual({
      layerId: 'farm',
      id: 't1234',
      properties: { index: 1234 },
    });
    layer.setFeatureState('t3', { selected: true });
    expect(models.highlights.get(3)).toEqual([1, 1, 0, 0.6]);
    layer.setFeatureState('t3', undefined);
    expect(models.highlights.get(3)).toBeUndefined();
    layer.setFeaturePosition('t3', 10, 46);
    expect(models.instances?.poses[3]?.position).toEqual({ longitudeDeg: 10, latitudeDeg: 46, heightMeters: 0 });
    layer.setVisible(false);
    expect(models.visible).toBe(false);
    stack.remove('farm');
    expect(models.removed).toEqual([7]);
  });

  it('takes its distance and placeholder, and refuses a missing file or a bad distance', () => {
    expect(() => new ModelSetLayer({ models: [] })).toThrow(RangeError);
    expect(() => new ModelSetLayer({ url: 'a.glb', models: [], visibleBelowMeters: -1 })).toThrow(RangeError);
    const models = fakeSets();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    stack.add(
      new ModelSetLayer({
        url: 'a.glb',
        models: [],
        visibleBelowMeters: 1500,
        placeholder: { color: [0, 0, 1], sizePx: 0 },
      }),
    );
    expect(models.loads[0]?.options).toEqual({
      visibleBelowMeters: 1500,
      placeholderColor: [0, 0, 1],
      placeholderSizePx: 0,
    });
  });

  it('turns each copy at its speed, easing to a new one, and asks for frames only while drawn (F648)', async () => {
    const models = fakeSets();
    let requests = 0;
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }), () => void requests++);
    const turbines = [0, 1, 2].map((i) => ({
      id: `t${String(i)}`,
      position: { longitudeDeg: 9 + i * 0.01, latitudeDeg: 45 },
      ...(i === 2 ? { spinRpm: 6 } : {}),
    }));
    const layer = stack.add(
      new ModelSetLayer({ url: 't.glb', models: turbines, spin: { node: 'rotor', rpm: 12, rampSeconds: 0 } }),
    );
    await layer.ready;
    expect(models.loads[0]?.options.joints).toEqual([{ node: 'rotor', axis: 'z' }]);
    const angles = models.angles[0] ?? new Float32Array(0);
    const start = Array.from(angles);
    // Spread starting angles: the copies never turn in step.
    expect(new Set(start).size).toBe(3);
    const at = (nowMs: number): void =>
      stack.frame({ nowMs, zoom: 15, projector: { geoToScreen: () => undefined, zoom: () => 15 } });
    at(0);
    at(100);
    // 12 turns a minute: 0.02 turns in 100 ms; the third copy at its own 6.
    const turned = (i: number): number => ((angles[i] ?? 0) - (start[i] ?? 0) + 2 * Math.PI) % (2 * Math.PI);
    expect(turned(0)).toBeCloseTo(0.02 * 2 * Math.PI, 5);
    expect(turned(2)).toBeCloseTo(0.01 * 2 * Math.PI, 5);
    // Not drawn: no more frames once the kick after loading has passed; drawn again, a frame each frame.
    models.drawn = 0;
    at(116);
    at(132);
    requests = 0;
    at(148);
    expect(requests).toBe(0);
    models.drawn = 2;
    at(164);
    expect(requests).toBe(1);
    // Stopped: no frames at all.
    expect(layer.setSpinRpm(0)).toBe(true);
    requests = 0;
    at(180);
    at(196);
    expect(requests).toBe(0);
    expect(layer.getSpinRpm('t1')).toBe(0);
    expect(layer.setSpinRpm(5, 'nope')).toBe(false);
    expect(() => layer.setSpinRpm(Number.NaN)).toThrow(RangeError);
  });

  it('eases a speed change over its ramp and refuses bad spin options (F648)', async () => {
    const models = fakeSets();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    const one = [{ id: 'a', position: { longitudeDeg: 9, latitudeDeg: 45 } }];
    const layer = stack.add(new ModelSetLayer({ url: 't.glb', models: one, spin: { node: 'rotor', rampSeconds: 3 } }));
    await layer.ready;
    const angles = models.angles[0] ?? new Float32Array(0);
    const at = (nowMs: number): void =>
      stack.frame({ nowMs, zoom: 15, projector: { geoToScreen: () => undefined, zoom: () => 15 } });
    at(0);
    layer.setSpinRpm(10, 'a');
    // One second in, a third of the ramp: the speed covers 1 − e⁻¹ of the change; after the ramp, 95%.
    // The speed at a time, in turns per minute, from the angle turned over the next millisecond.
    const speedAt = (nowMs: number): number => {
      at(nowMs);
      const before = angles[0] ?? 0;
      at(nowMs + 1);
      return (((angles[0] ?? 0) - before + 2 * Math.PI) % (2 * Math.PI)) / ((2 * Math.PI) / 60_000);
    };
    for (let t = 16; t <= 1000; t += 16) at(t);
    expect(speedAt(1000)).toBeCloseTo(10 * (1 - Math.exp(-1)), 0);
    for (let t = 1016; t <= 3000; t += 16) at(t);
    expect(speedAt(3000)).toBeGreaterThan(9.4);
    // Settled exactly soon after: the last of the change goes at a turn per minute each second at least.
    for (let t = 3016; t <= 3600; t += 16) at(t);
    expect(layer.getSpinRpm('a')).toBe(10);
    expect(speedAt(3600)).toBeCloseTo(10, 1);
    expect(() => new ModelSetLayer({ url: 'a', models: [], spin: { node: 'r', rampSeconds: -1 } })).toThrow(RangeError);
    expect(() => new ModelSetLayer({ url: 'a', models: one, spin: { node: 'r', rpm: Infinity } })).toThrow(RangeError);
    expect(new ModelSetLayer({ url: 'a', models: one }).setSpinRpm(3)).toBe(false);
  });

  it('turns a yawing part to face a direction the shorter way at its rate, holding the spinning part (F648)', async () => {
    const models = fakeSets();
    let requests = 0;
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }), () => void requests++);
    const turbines = [
      { id: 'a', position: { longitudeDeg: 9, latitudeDeg: 45 }, headingDeg: 180, yawDeg: 270 },
      { id: 'b', position: { longitudeDeg: 9.01, latitudeDeg: 45 } },
    ];
    const layer = stack.add(
      new ModelSetLayer({
        url: 't.glb',
        models: turbines,
        yaw: { node: 'nacelle', degPerSecond: 10 },
        spin: { node: 'rotor', rpm: 12 },
      }),
    );
    await layer.ready;
    // The nacelle holds the rotor: it comes first.
    expect(models.loads[0]?.options.joints).toEqual([
      { node: 'nacelle', axis: 'y' },
      { node: 'rotor', axis: 'z' },
    ]);
    const yaw = models.angles[0] ?? new Float32Array(0);
    // Facing west on a heading of south: a quarter turn clockwise seen from above, about −Y.
    expect(yaw[0]).toBeCloseTo(-Math.PI / 2, 6);
    expect(yaw[1]).toBeCloseTo(0, 9);
    expect(layer.getYawDeg('a')).toBeCloseTo(270, 4);
    const at = (nowMs: number): void =>
      stack.frame({ nowMs, zoom: 15, projector: { geoToScreen: () => undefined, zoom: () => 15 } });
    at(0);
    // To north-west, 45° clockwise: 4.5 s at 10° a second, then still (the shorter way, not 315° the other way).
    expect(layer.setYawDeg(315, 'a')).toBe(true);
    for (let t = 100; t <= 2000; t += 100) at(t);
    expect(yaw[0]).toBeCloseTo((-90 - 20) * (Math.PI / 180), 4);
    for (let t = 2100; t <= 5000; t += 100) at(t);
    expect(yaw[0]).toBeCloseTo((-135 * Math.PI) / 180, 5);
    expect(layer.getYawDeg('a')).toBeCloseTo(315, 3);
    // Every copy, across north: 'b' (heading 0) turns 30° counter-clockwise to 330.
    layer.setYawDeg(330);
    for (let t = 5100; t <= 9000; t += 100) at(t);
    expect(yaw[1]).toBeCloseTo((30 * Math.PI) / 180, 5);
    expect(layer.getYawDeg('b')).toBeCloseTo(330, 3);
    expect(layer.setYawDeg(10, 'nope')).toBe(false);
    expect(() => layer.setYawDeg(Number.NaN)).toThrow(RangeError);
    expect(() => new ModelSetLayer({ url: 'a', models: [], yaw: { node: 'n', degPerSecond: 0 } })).toThrow(RangeError);
    expect(new ModelSetLayer({ url: 'a', models: turbines }).setYawDeg(90)).toBe(false);
  });
});

/** A ground whose height at a longitude is `heights[lon]`, with its terrain uploads and relief set by the test. */
function fakeGround(heights: Record<number, number>): ModelSetGround & {
  uploads: number;
  samples: number;
  cameraReads: number;
  relief: number;
} {
  const ground = {
    uploads: 1,
    samples: 0,
    cameraReads: 0,
    relief: 1,
    // A globe builds its camera's state at each read: counted.
    get camera() {
      ground.cameraReads++;
      return { reliefFactor: ground.relief };
    },
    elevationAt: (position: GeoPosition, out: ElevationSample) => {
      ground.samples++;
      out.heightMeters = heights[position.longitudeDeg] ?? 0;
      return out;
    },
    terrainStats: () => ({ uploads: ground.uploads }),
  };
  return ground;
}

const PROJECTOR = { geoToScreen: () => undefined, zoom: () => 14 };

describe('model set on the ground (F655)', () => {
  it('stands its copies on the terrain in memory, again only when finer terrain arrives and the relief is not flat', async () => {
    expectTypeOf<Globe>().toExtend<ModelSetGround>();
    const models = fakeSets();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    const heights: Record<number, number> = { 9: 120, 10: 300 };
    const ground = fakeGround(heights);
    const layer = stack.add(
      new ModelSetLayer({
        url: 'turbine.glb',
        ground,
        models: [
          { id: 'a', position: { longitudeDeg: 9, latitudeDeg: 45 } },
          { id: 'b', position: { longitudeDeg: 10, latitudeDeg: 45, heightMeters: 5 } },
        ],
      }),
    );
    await layer.ready;
    const heightsDrawn = (): (number | undefined)[] =>
      models.instances?.poses.map((p) => p.position.heightMeters) ?? [];
    expect(heightsDrawn()).toEqual([120, 305]);
    const frame = (): void => stack.frame({ nowMs: 0, zoom: 14, projector: PROJECTOR });
    const reads = ground.cameraReads;
    frame();
    expect(ground.samples).toBe(2);
    expect(models.instanceUploads).toBe(1);
    // No finer terrain: the frame reads neither the ground nor the camera.
    expect(ground.cameraReads).toBe(reads);
    // Finer terrain arrived.
    heights[9] = 118;
    ground.uploads++;
    frame();
    expect(heightsDrawn()).toEqual([118, 305]);
    // A flat relief draws every height at 0: nothing is sampled until it rises again.
    ground.relief = 0;
    ground.uploads++;
    frame();
    expect(ground.samples).toBe(4);
    ground.relief = 0.5;
    frame();
    expect(ground.samples).toBe(6);
    // The renderer scales the drawn heights by the relief, not the model: 84 m above `b`'s foot is 168 m in a position.
    expect(layer.markerPosition('b', 84)).toEqual({ longitudeDeg: 10, latitudeDeg: 45, heightMeters: 305 + 168 });
    expect(layer.getPosition('b')).toEqual({ longitudeDeg: 10, latitudeDeg: 45, heightMeters: 5 });
    layer.setFeaturePosition('a', 10, 45, 2);
    expect(heightsDrawn()).toEqual([302, 305]);
    expect(layer.markerPosition('a', 84, 0.25)?.heightMeters).toBe(302 + 336);
    ground.relief = 0;
    expect(layer.markerPosition('a', 84)).toEqual({ longitudeDeg: 10, latitudeDeg: 45, heightMeters: 302 });
    expect(layer.markerPosition('missing')).toBeUndefined();
  });

  it('reports a ground it cannot read once and leaves the copies where they stand', async () => {
    const models = fakeSets();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    const ground = fakeGround({});
    ground.elevationAt = () => {
      throw new Error('display only');
    };
    const layer = stack.add(
      new ModelSetLayer({
        url: 'a.glb',
        ground,
        models: [{ id: 'a', position: { longitudeDeg: 9, latitudeDeg: 45 } }],
      }),
    );
    const errors: unknown[] = [];
    layer.on('error', (error) => errors.push(error.cause));
    await layer.ready;
    ground.uploads++;
    stack.frame({ nowMs: 0, zoom: 14, projector: PROJECTOR });
    expect(errors).toHaveLength(1);
    expect(models.instances?.poses[0]?.position).toEqual({ longitudeDeg: 9, latitudeDeg: 45 });
  });
});
