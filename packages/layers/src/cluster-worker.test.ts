import { describe, expect, it } from 'vitest';
import type { TaskContext } from '@vibeglobe/core';
import type { ClusterItem } from './cluster.js';
import { CLUSTER_TASKS, workerClusterEngine } from './cluster-worker.js';

const run = async (name: string, input: object): Promise<unknown> =>
  (await CLUSTER_TASKS[name]?.(input, {} as TaskContext))?.output;

describe('clustering tasks (F373)', () => {
  it('keeps an index per id between tasks: load, items, expansion, leaves and destroy', async () => {
    // Ten points close together near Rome and one far away.
    const lonLatDeg = Float64Array.from([
      ...Array.from({ length: 10 }, (_, i) => [12.5 + i * 0.001, 41.9]).flat(),
      ...[-70, -30],
    ]);
    expect(await run('cluster-load', { id: 7, lonLatDeg, options: {} })).toBe(true);
    const items = (await run('cluster-items', { id: 7, zoom: 3 })) as ClusterItem[];
    expect(items.reduce((sum, item) => sum + item.count, 0)).toBe(11);
    const cluster = items.find((item) => item.clusterId !== undefined);
    expect(cluster?.count).toBe(10);
    expect(await run('cluster-expansion', { id: 7, clusterId: cluster?.clusterId })).toBeGreaterThan(3);
    expect(((await run('cluster-leaves', { id: 7, clusterId: cluster?.clusterId })) as number[]).length).toBe(10);
    expect(await run('cluster-destroy', { id: 7 })).toBe(true);
    await expect(run('cluster-items', { id: 7, zoom: 3 })).rejects.toThrow('no cluster index');
  });

  it('works again after a destroy, as a layer removed from the stack and added back rebuilds its index', async () => {
    // Workers cannot start in Node: the pool runs the tasks on the main thread.
    const engine = workerClusterEngine({
      url: 'test://cluster-reuse',
      create: () => {
        throw new Error('no workers here');
      },
      inline: () => Promise.resolve(CLUSTER_TASKS),
    });
    const lonLatDeg = Float64Array.from([12.5, 41.9, -70, -30]);
    await engine.load(lonLatDeg, {});
    expect((await engine.items(3)).length).toBe(2);
    engine.destroy();
    await engine.load(lonLatDeg, {});
    expect((await engine.items(3)).length).toBe(2);
    engine.destroy();
  });
});
