// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { GlobeError } from './errors.js';
import type { NetworkPool } from '../scheduler/network-pool.js';
import type { WorkerPool, WorkerPoolLease } from '../scheduler/worker-pool-types.js';
import type { WorkerEndpointFactory } from '../scheduler/worker-protocol.js';
import { acquirePools, releaseNetworkPool } from './page-network.js';
import type { CreditedSource } from '../imagery/credits.js';
import { extensionCredits, type RuntimeCredits } from './runtime-credits.js';
import type { FrameView, RendererBackend } from './types.js';

/** The imagery runtime's parts an extension uses: its pools, and the credits it merges the extension's into. */
interface ExtensionImagery {
  readonly network: NetworkPool;
  readonly lease: WorkerPoolLease;
  readonly credits?: RuntimeCredits;
}

/** The engine's parts an extension uses, read when it is added. */
export interface ExtensionParts {
  readonly globe: { requestRender(): void };
  renderer(): RendererBackend | undefined;
  surface(): { readonly imagery?: ExtensionImagery | undefined };
  readonly workers: WorkerEndpointFactory | undefined;
  /** Logs a problem and emits it as the globe's `error` event. */
  report(error: GlobeError): void;
}

/**
 * {@link addExtension} for an engine: with its imagery runtime's pools, or its own while it has workers but no tiled
 * imagery or terrain (track D hook 4).
 */
export function extendGlobe(
  parts: ExtensionParts,
  create: (context: RenderExtensionContext) => RenderExtension,
): () => void {
  const renderer = parts.renderer();
  const imagery = parts.surface().imagery ?? extensionPools(parts, parts.workers, renderer);
  return addExtension(
    renderer,
    create,
    () => parts.globe.requestRender(),
    imagery,
    (error) => parts.report(error),
  );
}

/** Each engine's own pools for its extensions, while it has workers but no tiled imagery or terrain (track D hook 4). */
const ownPools = new WeakMap<object, { readonly network: NetworkPool; readonly lease: WorkerPoolLease }>();

/**
 * The pools of `owner`'s render extensions on a globe with `workers` but no imagery runtime: the page's network pool
 * and a lease on the worker pool, taken at the first extension and released by {@link releaseExtensionPools}.
 */
function extensionPools(
  owner: object,
  workers: WorkerEndpointFactory | undefined,
  renderer: RendererBackend | undefined,
): ExtensionImagery | undefined {
  if (!workers || !renderer) return undefined;
  let pools = ownPools.get(owner);
  if (!pools) {
    pools = acquirePools(workers, renderer.host);
    ownPools.set(owner, pools);
  }
  return pools;
}

/** Releases `owner`'s extension pools, if it took them (the globe is destroyed). */
export function releaseExtensionPools(owner: object): void {
  const pools = ownPools.get(owner);
  if (!pools) return;
  ownPools.delete(owner);
  pools.lease.release();
  releaseNetworkPool(pools.network);
}

/**
 * Adds a renderer subsystem built outside the core loop (`Globe.addRenderExtension`, M13): `create` receives the
 * renderer's own context and a way to ask for a frame, and its extension places its objects every frame. Returns the
 * function that removes it.
 */
export function addExtension(
  renderer: RendererBackend | undefined,
  create: (context: RenderExtensionContext) => RenderExtension,
  requestRender: () => void,
  imagery?: ExtensionImagery,
  report: (error: GlobeError) => void = () => undefined,
): () => void {
  const extensions = renderer?.extensions;
  if (!extensions)
    throw new GlobeError(
      'invalid-option',
      'Render extensions can be added once the globe is ready, on a renderer that has them',
    );
  // The key of this extension's credits: they are merged into the globe's while it is added (track E hook 2).
  const owner = {};
  let byExtension = extensionCredits.get(renderer);
  if (!byExtension) extensionCredits.set(renderer, (byExtension = new Map()));
  const credited = byExtension;
  const setCredits = (sources: readonly CreditedSource[]): void => {
    if (sources.length === 0) credited.delete(owner);
    else credited.set(owner, [...sources]);
    imagery?.credits?.refresh();
  };
  const created = create({
    renderer: extensions.context,
    requestRender,
    setCredits,
    report,
    ...(imagery ? { network: imagery.network, workers: imagery.lease.pool } : {}),
  });
  // Without an imagery runtime nothing else runs the worker pool's per-frame step: the extension's frame does.
  const pool = imagery && !imagery.credits ? imagery.lease.pool : undefined;
  const extension: RenderExtension = pool
    ? {
        frame: (view) => {
          pool.update();
          created.frame(view);
        },
        dispose: () => created.dispose(),
      }
    : created;
  const remove = extensions.add(extension);
  requestRender();
  return () => {
    remove();
    setCredits([]);
    requestRender();
  };
}

/** A renderer subsystem added from outside the core loop (`Globe.addRenderExtension`, M13). */
export interface RenderExtension {
  /** Places the extension's objects for this frame (camera-relative, as `view` gives the eye), before drawing. */
  frame(view: FrameView): void;
  /** Frees its GPU resources: on removal, on the globe's destruction, and before a renderer recovery rebuilds it. */
  dispose(): void;
}

/** What a render extension's factory receives. */
export interface RenderExtensionContext {
  /** The renderer's own context, as `RendererBackend.extensionContext` gives it. */
  readonly renderer: unknown;
  /** Asks for a frame: after loading content, or while animating. */
  requestRender(): void;
  /**
   * The sources whose content the extension draws now, each with its attribution and provider profile: their credits
   * join `Globe.credits()`, `credits-change` and the attribution element, a profile's required credit (a logo) pinned
   * as for imagery (F254, F255; F679 for a provider's 3D Tiles). Replaces the extension's previous ones; `[]` clears them.
   */
  setCredits(sources: readonly CreditedSource[]): void;
  /**
   * Reports a problem of the extension's content (an invalid style, a tile that failed): the globe logs it and emits it
   * as its `error` event (track D hook 1, F451).
   */
  report(error: GlobeError): void;
  /**
   * The page's request pool (per-host limits, coalescing, cancellation, the measured link; F462): an extension
   * queues its own requests by priority and starts them when `hasFreeSlot` allows. Absent on a globe without imagery.
   */
  readonly network?: NetworkPool;
  /** The engine's worker pool: its tasks (`layout-vector-tile`, `parse-model`, …) run there. Absent likewise. */
  readonly workers?: WorkerPool;
}
