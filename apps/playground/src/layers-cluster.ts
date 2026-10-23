import type { Globe, WorkerEndpointFactory } from '@vibeglobe/core';
import { ClusterLayer, createGlobeLayers, type Feature } from '@vibeglobe/layers';
import { workerClusterEngine } from '@vibeglobe/layers/cluster-worker';
import { createWorkers } from '@vibeglobe/worker';

/** A deterministic pseudo-random sequence, so every run clusters the same points. */
function random(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/**
 * `?scenario=data-cluster` (F373): 100,000 points (`&points=` to change), half of them spread worldwide and half
 * around Rome, clustered in a worker of the engine's worker program (`window.vibeglobeCluster.tasks` lists the tasks
 * it posted). A click on a cluster fits the view to its points.
 */
export function showCluster(globe: Globe, count: number): void {
  const element = document.querySelector<HTMLElement>('#globe') ?? undefined;
  const { stack, interaction } = createGlobeLayers(globe, element ? { element } : {});
  const base = createWorkers();
  const tasks: string[] = [];
  const workers: WorkerEndpointFactory = {
    ...base,
    create(onMessage, onError) {
      const endpoint = base.create(onMessage, onError);
      return {
        post(message, transfer) {
          if ('task' in message) tasks.push(message.task);
          endpoint.post(message, transfer);
        },
        terminate: () => endpoint.terminate(),
      };
    },
  };
  const next = random(42);
  const positions: [number, number][] = [];
  const features: Feature[] = Array.from({ length: count }, (_, i) => {
    const near = i % 2 === 0;
    const lon = near ? 12.5 + (next() - 0.5) * 4 : (next() - 0.5) * 360;
    const lat = near ? 41.9 + (next() - 0.5) * 3 : ((Math.asin(2 * next() - 1) * 180) / Math.PI) * 0.95;
    return {
      type: 'Feature',
      id: `pt${String(i)}`,
      properties: {},
      geometry: { type: 'Point', coordinates: [lon, lat] },
    };
  });
  const layer = stack.add(
    new ClusterLayer({
      id: 'clusters',
      data: features,
      engine: workerClusterEngine(workers),
      style: {
        'circle-color': ['case', ['boolean', ['get', 'cluster'], false], '#ff8000', '#2050ff'],
        'circle-radius': ['case', ['boolean', ['get', 'cluster'], false], 12, 4],
      },
    }),
  );
  layer.on('click', ({ feature }) => {
    const id = feature.properties['cluster_id'];
    if (typeof id !== 'number') return;
    void layer.clusterExtent(id).then(({ bounds }) => {
      if (bounds) void globe.fitBounds(bounds, { movement: 'ease', durationMs: 600, paddingPx: 20 });
    });
  });
  window.vibeglobeCluster = { layer, interaction, tasks, positions };
}

declare global {
  interface Window {
    vibeglobeCluster?: {
      readonly layer: ClusterLayer;
      readonly interaction: unknown;
      readonly tasks: readonly string[];
      readonly positions: readonly (readonly number[])[];
    };
  }
}
