// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { ModelDescription } from '@vibeglobe/models';
import { Raycaster, Vector3, type BufferGeometry, type Intersection, type Object3D } from 'three/webgpu';
import type { ThreeExtensionContext } from '../extensions.js';
import {
  buildModelMeshes,
  decodeBrowserImage,
  type ImageDecoder,
  type ModelMeshes,
  type RawImage,
} from './model-meshes.js';
import type { WorkerPool, WorkerTaskOutcome } from '@vibeglobe/core';

/** A ray hit on 3D Tiles content. */
export interface TileMeshHit {
  /** The key the content was added with. */
  readonly key: number;
  /** Distance from the ray origin in meters. */
  readonly distanceMeters: number;
  /** The hit point, in the world space of the ray (camera-relative, ADR 0004). */
  readonly point: readonly [number, number, number];
  /** The values of the hit vertex's feature attributes (`_BATCHID`, `_FEATURE_ID_n`), by glTF name. */
  readonly featureIds: Readonly<Record<string, number>>;
  /** Index of the instance's glTF node, for the content's metadata. */
  readonly node: number;
}

/**
 * The meshes of 3D Tiles content in a three.js scene (F461, F466; ADR 0141): what the tileset loader of
 * `@vibeglobe/sources/tiles3d` (`TileMeshes`) drives. Every content is a model placed by a float64 content-to-world
 * matrix, written camera-relative each frame, shown or hidden as the traversal selects it, and picked by ray.
 */
export class ThreeTileMeshes {
  private readonly contents = new Map<number, ModelMeshes>();
  private readonly raycaster = new Raycaster();
  private disposed = false;

  constructor(
    private readonly context: ThreeExtensionContext,
    private readonly decodeImage?: ImageDecoder,
  ) {}

  /** Builds and adds a decoded model, hidden until shown; resolves with the bytes it holds. */
  async add(key: number, model: unknown): Promise<number> {
    const meshes = await buildModelMeshes(model as ModelDescription, {
      depthPath: this.context.depthPath(),
      ...(this.decodeImage ? { decodeImage: this.decodeImage } : {}),
    });
    if (this.disposed) {
      meshes.dispose();
      return 0;
    }
    this.remove(key);
    meshes.root.visible = false;
    meshes.root.userData['tileKey'] = key;
    this.contents.set(key, meshes);
    this.context.scene.add(meshes.root);
    return meshes.bytes;
  }

  /** Writes a content's content-to-world matrix (column-major float64, translation relative to the eye). */
  setMatrix(key: number, matrix: ArrayLike<number>): void {
    const root = this.contents.get(key)?.root;
    if (!root) return;
    const e = root.matrix.elements;
    for (let i = 0; i < 16; i++) e[i] = matrix[i] ?? 0;
    root.matrixWorldNeedsUpdate = true;
    root.updateMatrixWorld(true);
  }

  /** Shows or hides a content. */
  setVisible(key: number, visible: boolean): void {
    const root = this.contents.get(key)?.root;
    if (root) root.visible = visible;
  }

  /** Removes a content and frees its GPU resources. */
  remove(key: number): void {
    const meshes = this.contents.get(key);
    if (!meshes) return;
    this.context.scene.remove(meshes.root);
    meshes.dispose();
    this.contents.delete(key);
  }

  /** Contents held. */
  get size(): number {
    return this.contents.size;
  }

  /** The nearest visible content along a ray in world space (origin and unit direction). */
  raycast(origin: ArrayLike<number>, direction: ArrayLike<number>): TileMeshHit | undefined {
    this.raycaster.set(
      new Vector3(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0),
      new Vector3(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 1).normalize(),
    );
    const roots: Object3D[] = [];
    for (const { root } of this.contents.values()) if (root.visible) roots.push(root);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    return hit ? toHit(hit) : undefined;
  }

  /** Removes every content. */
  dispose(): void {
    for (const key of [...this.contents.keys()]) this.remove(key);
    this.disposed = true;
  }
}

function toHit(hit: Intersection): TileMeshHit {
  let root: Object3D | null = hit.object;
  while (root && root.userData['tileKey'] === undefined) root = root.parent;
  const featureIds: Record<string, number> = {};
  const geometry = (hit.object as Partial<{ geometry: BufferGeometry }>).geometry;
  const vertex = hit.face?.a ?? hit.index;
  if (geometry && vertex !== undefined)
    for (const [name, attribute] of Object.entries(geometry.attributes))
      if (name === '_BATCHID' || name.startsWith('_FEATURE_ID_')) featureIds[name] = attribute.getX(vertex);
  return {
    key: (root?.userData['tileKey'] as number | undefined) ?? -1,
    distanceMeters: hit.distance,
    point: [hit.point.x, hit.point.y, hit.point.z],
    featureIds,
    node: (hit.object.userData['node'] as number | undefined) ?? -1,
  };
}

/** What {@link threeTileMeshes} reads of a render extension's context (`Globe.addRenderExtension`). */
export interface TileMeshContext {
  /** The three.js renderer's {@link ThreeExtensionContext}. */
  readonly renderer: unknown;
  /** The engine's worker pool: KTX2 textures are transcoded there (`transcode-ktx2`, ADR 0020). */
  readonly workers?: WorkerPool;
}

/** Transcodes KTX2 images to RGBA8 with the worker program's `transcode-ktx2` task; other images in the browser. */
function workerImageDecoder(workers: WorkerPool | undefined): ImageDecoder {
  return async (image) => {
    if (image.mimeType !== 'image/ktx2') return decodeBrowserImage(image);
    if (!workers) return undefined;
    const bytes = image.bytes.slice().buffer;
    const outcome = await new Promise<WorkerTaskOutcome>((resolve) =>
      workers.run({ task: 'transcode-ktx2', input: { bytes, formats: [] }, transfer: [bytes] }, resolve),
    );
    if (!outcome.ok) return undefined;
    return (outcome.output as { image?: RawImage }).image;
  };
}

/** The `TileMeshes` of a three.js render extension's context, for the tileset loader of `@vibeglobe/sources/tiles3d`. */
export function threeTileMeshes(context: TileMeshContext, decodeImage?: ImageDecoder): ThreeTileMeshes {
  return new ThreeTileMeshes(
    context.renderer as ThreeExtensionContext,
    decodeImage ?? workerImageDecoder(context.workers),
  );
}
