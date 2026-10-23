import type { StackLayer } from '../imagery/imagery-draws.js';
import {
  applyChanges,
  sourceInfo,
  type ImageryLayerChanges,
  type ImageryLayers,
  type ImageryLayerState,
} from '../imagery/imagery-stack.js';
import { GlobeError } from './errors.js';

/** What holds a globe's imagery runtime (its `SurfaceFrame`). */
interface ImageryHolder {
  readonly imagery?: { readonly stack: StackLayer[]; stackChanged(): void } | undefined;
}

/**
 * The controllers of the globes' imagery, kept outside the per-frame classes: a field more on those changes how V8 lays
 * them out, and their per-frame writes start to allocate (F064).
 */
const controllers = new WeakMap<ImageryHolder, ImageryLayersController>();

/** `Globe.imageryLayers` of the globe whose imagery `frame` holds. */
export function imageryLayersOf(frame: ImageryHolder): ImageryLayers {
  let controller = controllers.get(frame);
  if (!controller) {
    controller = new ImageryLayersController(frame);
    controllers.set(frame, controller);
  }
  return controller;
}

/**
 * `Globe.imageryLayers` (F243–F246): reads and changes the imagery stack in place; every change asks for a frame, which
 * shows it. Before the imagery starts (and without imagery) the stack is empty.
 */
class ImageryLayersController implements ImageryLayers {
  /** `frame` holds the imagery runtime once it starts. */
  constructor(private readonly frame: ImageryHolder) {}

  private stack(): StackLayer[] | undefined {
    return this.frame.imagery?.stack;
  }

  private changed(): void {
    this.frame.imagery?.stackChanged();
  }

  /** See {@link ImageryLayers.list}. */
  list(): readonly ImageryLayerState[] {
    return (this.stack() ?? []).map(({ entry }) => ({
      id: entry.id,
      opacity: entry.opacity,
      visible: entry.visible,
      blend: entry.blend,
      sources: entry.sources.map(sourceInfo),
    }));
  }

  /** See {@link ImageryLayers.set}. */
  set(id: string, changes: ImageryLayerChanges): void {
    const layer = this.find(id);
    try {
      applyChanges(layer.entry, changes);
    } catch (error) {
      throw new GlobeError('invalid-option', error instanceof Error ? error.message : String(error));
    }
    this.changed();
  }

  /** See {@link ImageryLayers.move}. */
  move(id: string, index: number): void {
    const stack = this.stack() ?? [];
    const layer = this.find(id);
    stack.splice(stack.indexOf(layer), 1);
    const to = Math.max(0, Math.min(stack.length, Math.round(index)));
    stack.splice(to, 0, layer);
    this.changed();
  }

  private find(id: string): StackLayer {
    const layer = this.stack()?.find((candidate) => candidate.entry.id === id);
    if (!layer) throw new GlobeError('invalid-option', `No imagery layer has the id "${id}"`);
    return layer;
  }
}
