// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Point clustering through supercluster (ISC; ADR 0029) behind an asynchronous interface, so the index can be built in
 * the shared worker pool once the worker package hosts it (docs/parallel-tracks.md, hook request); until then
 * {@link localClusterEngine} runs it on the calling thread.
 */
import Supercluster from 'supercluster';

/** Clustering settings (MapLibre's `clusterRadius`, `clusterMaxZoom`, `clusterMinPoints`). */
export interface ClusterOptions {
  /** Cluster radius in CSS pixels at 512-px tiles (default 50, as MapLibre). */
  readonly radiusPx?: number;
  /** Last zoom with clusters; above it every point shows (default 16). */
  readonly maxZoom?: number;
  /** Fewest points that form a cluster (default 2). */
  readonly minPoints?: number;
  /** Duration of split and merge animations (default 300 ms). */
  readonly transitionMs?: number;
}

/** One item shown at a zoom: a cluster or a single point. */
export interface ClusterItem {
  /** Stable key: `c<clusterId>` for clusters, `p<pointIndex>` for points. */
  readonly key: string;
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
  /** Points it stands for (1 for a single point). */
  readonly count: number;
  readonly clusterId?: number;
  /** For single points: the index in the loaded point array. */
  readonly pointIndex?: number;
}

/** A geographic rectangle in degrees. */
export interface GeoBoundsDeg {
  readonly westDeg: number;
  readonly southDeg: number;
  readonly eastDeg: number;
  readonly northDeg: number;
}

/** The clustering index. Every call is asynchronous so an implementation may run in a worker. */
export interface ClusterEngine {
  /** Builds the index from interleaved longitude and latitude pairs, replacing any previous one. */
  load(lonLatDeg: Float64Array, options: ClusterOptions): Promise<void>;
  /** Clusters and points of the whole world at an integer zoom. */
  items(zoom: number): Promise<readonly ClusterItem[]>;
  /** Zoom at which a cluster splits into its children. */
  expansionZoom(clusterId: number): Promise<number>;
  /** Point indices a cluster stands for. */
  leaves(clusterId: number): Promise<readonly number[]>;
  /** Frees the index. */
  destroy(): void;
}

type PointProps = { i: number };

/** A cluster engine on the calling thread. */
export function localClusterEngine(): ClusterEngine {
  let index: Supercluster<PointProps> | undefined;
  const ready = (): Supercluster<PointProps> => {
    if (index === undefined) throw new Error('cluster index not loaded');
    return index;
  };
  return {
    load(lonLatDeg, options) {
      const points = [];
      for (let i = 0; i < lonLatDeg.length / 2; i++) {
        points.push({
          type: 'Feature' as const,
          properties: { i },
          geometry: { type: 'Point' as const, coordinates: [lonLatDeg[2 * i] ?? 0, lonLatDeg[2 * i + 1] ?? 0] },
        });
      }
      index = new Supercluster<PointProps>({
        radius: options.radiusPx ?? 50,
        maxZoom: options.maxZoom ?? 16,
        minPoints: options.minPoints ?? 2,
        extent: 512,
      }).load(points);
      return Promise.resolve();
    },
    items(zoom) {
      const items: ClusterItem[] = ready()
        .getClusters([-180, -90, 180, 90], zoom)
        .map((f) => {
          const [longitudeDeg = 0, latitudeDeg = 0] = f.geometry.coordinates;
          const p = f.properties;
          return 'cluster' in p && p.cluster
            ? { key: `c${p.cluster_id}`, longitudeDeg, latitudeDeg, count: p.point_count, clusterId: p.cluster_id }
            : { key: `p${(p as PointProps).i}`, longitudeDeg, latitudeDeg, count: 1, pointIndex: (p as PointProps).i };
        });
      return Promise.resolve(items);
    },
    expansionZoom(clusterId) {
      return Promise.resolve(ready().getClusterExpansionZoom(clusterId));
    },
    leaves(clusterId) {
      return Promise.resolve(
        ready()
          .getLeaves(clusterId, Infinity)
          .map((f) => (f.properties as PointProps).i),
      );
    },
    destroy() {
      index = undefined;
    },
  };
}

/** The bounds of a set of positions given as interleaved longitude and latitude pairs and indices into them. */
export function boundsOf(lonLatDeg: Float64Array, indices: readonly number[]): GeoBoundsDeg | undefined {
  if (indices.length === 0) return undefined;
  let westDeg = Infinity;
  let southDeg = Infinity;
  let eastDeg = -Infinity;
  let northDeg = -Infinity;
  for (const i of indices) {
    const lon = lonLatDeg[2 * i] ?? 0;
    const lat = lonLatDeg[2 * i + 1] ?? 0;
    westDeg = Math.min(westDeg, lon);
    eastDeg = Math.max(eastDeg, lon);
    southDeg = Math.min(southDeg, lat);
    northDeg = Math.max(northDeg, lat);
  }
  return { westDeg, southDeg, eastDeg, northDeg };
}
