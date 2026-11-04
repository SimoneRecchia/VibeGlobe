// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { GlobeError } from './errors.js';
import type { NetworkPool } from '../scheduler/network-pool.js';
import type { WorkerPool, WorkerPoolLease } from '../scheduler/worker-pool-types.js';
import type { CreditedSource } from '../imagery/credits.js';
import { extensionCredits, type RuntimeCredits } from './runtime-credits.js';
import type { FrameView, RendererBackend } from './types.js';

/** The imagery runtime's parts an extension uses: its pools, and the credits it merges the extension's into. */
interface ExtensionImagery {
  readonly network: NetworkPool;
  readonly lease: WorkerPoolLease;
  readonly credits: RuntimeCredits;
}

/** The engine's parts an extension uses, read when it is added. */
export interface ExtensionParts {
  readonly globe: { requestRender(): void };
  renderer(): RendererBackend | undefined;
  surface(): { readonly imagery?: ExtensionImagery | undefined };
  /** Logs a problem and emits it as the globe's `error` event. */
  report(error: GlobeError): void;
}

/** {@link addExtension} for an engine: with its imagery runtime's pools and credits when it has workers (track D hook 4). */
export function extendGlobe(
  parts: ExtensionParts,
  create: (context: RenderExtensionContext) => RenderExtension,
): () => void {
  return addExtension(
    parts.renderer(),
    create,
    () => parts.globe.requestRender(),
    parts.surface().imagery,
    (error) => parts.report(error),
  );
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
    imagery?.credits.refresh();
  };
  const created = create({
    renderer: extensions.context,
    requestRender,
    setCredits,
    report,
    ...(imagery ? { network: imagery.network, workers: imagery.lease.pool } : {}),
  });
  const remove = extensions.add(created);
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
   * queues its own requests by priority and starts them when `hasFreeSlot` allows. Absent on a globe without workers.
   */
  readonly network?: NetworkPool;
  /** The engine's worker pool: its tasks (`layout-vector-tile`, `parse-model`, …) run there. Absent likewise. */
  readonly workers?: WorkerPool;
}
